import { format } from "date-fns";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import db from "../db.server";
import {
  importHistoricalCsv,
  validateCsvUpload,
  type ImportMode,
  type ImportSummary,
} from "../services/csvImport.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const batches = await db.importBatch.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return {
    batches: batches.map((batch) => ({
      id: batch.id,
      filename: batch.filename,
      totalRows: batch.totalRows,
      successRows: batch.successRows,
      failedRows: batch.failedRows,
      createdAt: batch.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();

  const file = formData.get("file");
  const uploadError = validateCsvUpload(file instanceof File ? file : null);

  if (uploadError) {
    return { error: uploadError };
  }

  const importMode = String(formData.get("importMode") ?? "skip") as ImportMode;
  const csvFile = file as File;
  const fileText = await csvFile.text();

  try {
    const summary = await importHistoricalCsv({
      shopId: shop.id,
      filename: csvFile.name,
      fileText,
      importMode,
    });

    return { summary };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Import failed. Please try again.";

    return { error: message };
  }
};

function ImportResult({ summary }: { summary: ImportSummary }) {
  const hasFailures = summary.failedRows > 0;

  return (
    <>
      <s-banner
        tone={hasFailures ? "warning" : "success"}
        heading={hasFailures ? "Import finished with issues" : "Import complete"}
      >
        Processed {summary.totalRows} rows from the file.
      </s-banner>

      <s-section heading="Import summary">
        <s-stack direction="block" gap="base">
          <s-text>Total rows: {summary.totalRows}</s-text>
          <s-text>Imported: {summary.importedRows}</s-text>
          <s-text>Updated: {summary.updatedRows}</s-text>
          <s-text>Skipped duplicates: {summary.skippedRows}</s-text>
          <s-text>Failed: {summary.failedRows}</s-text>
        </s-stack>
      </s-section>

      {summary.skipped.length > 0 && (
        <s-section heading="Skipped rows">
          <s-table>
            <s-table-header-row>
              <s-table-header>Row</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Serial number</s-table-header>
              <s-table-header>Reason</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {summary.skipped.map((row) => (
                <s-table-row key={`${row.rowNumber}-${row.serialNumber}`}>
                  <s-table-cell>{row.rowNumber}</s-table-cell>
                  <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                  <s-table-cell>{row.serialNumber ?? "—"}</s-table-cell>
                  <s-table-cell>{row.reason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      {summary.errors.length > 0 && (
        <s-section heading="Failed rows">
          <s-table>
            <s-table-header-row>
              <s-table-header>Row</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Serial number</s-table-header>
              <s-table-header>Error</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {summary.errors.map((row) => (
                <s-table-row key={`${row.rowNumber}-${row.serialNumber ?? "error"}`}>
                  <s-table-cell>{row.rowNumber}</s-table-cell>
                  <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                  <s-table-cell>{row.serialNumber ?? "—"}</s-table-cell>
                  <s-table-cell>{row.message}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </>
  );
}

export default function HistoricalCsvImportPage() {
  const { batches } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Historical CSV Import">
      {actionData && "error" in actionData && actionData.error && (
        <s-banner tone="critical" heading="Import failed">
          {actionData.error}
        </s-banner>
      )}

      {actionData && "summary" in actionData && actionData.summary && (
        <ImportResult summary={actionData.summary} />
      )}

      <s-section heading="Upload CSV">
        <s-text>
          Upload previous production records from CSV. Each row should represent
          one physical item with a unique serial number.
        </s-text>

        <Form method="post" encType="multipart/form-data">
          <s-stack direction="block" gap="base">
            <label>
              <s-text>CSV file</s-text>
              <input
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
              />
            </label>

            <s-select name="importMode" label="Import mode" value="skip">
              <s-option value="skip">Skip duplicates</s-option>
              <s-option value="update">Update existing</s-option>
              <s-option value="fail">Fail duplicates</s-option>
            </s-select>

            <s-button type="submit" variant="primary">
              Import CSV
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Supported columns">
        <s-text>
          Column names are flexible and not case-sensitive. Common examples:
        </s-text>
        <s-unordered-list>
          <s-list-item>SKU: sku, product sku, code, product code</s-list-item>
          <s-list-item>
            Product name: name, product name, description
          </s-list-item>
          <s-list-item>
            Serial number: serial number, serial, serial #
          </s-list-item>
          <s-list-item>
            Order number: order number, order, shopify order
          </s-list-item>
          <s-list-item>
            Production date: production date, made date, date
          </s-list-item>
          <s-list-item>
            Employee: employee, made by, operator, worker
          </s-list-item>
          <s-list-item>Status: status, production status</s-list-item>
          <s-list-item>Notes: notes, comment, remarks</s-list-item>
        </s-unordered-list>
        <s-text>
          If status is blank and an order number is present, the item is marked
          Shipped. If both are blank, it is marked In stock.
        </s-text>
      </s-section>

      <s-section heading="Past imports">
        {batches.length === 0 ? (
          <s-text>No imports have been run yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>File</s-table-header>
              <s-table-header>Rows</s-table-header>
              <s-table-header>Saved</s-table-header>
              <s-table-header>Failed</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {batches.map((batch) => (
                <s-table-row key={batch.id}>
                  <s-table-cell>{batch.filename}</s-table-cell>
                  <s-table-cell>{batch.totalRows}</s-table-cell>
                  <s-table-cell>{batch.successRows}</s-table-cell>
                  <s-table-cell>
                    {batch.failedRows > 0 ? batch.failedRows : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {format(new Date(batch.createdAt), "MMM d, yyyy HH:mm")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
