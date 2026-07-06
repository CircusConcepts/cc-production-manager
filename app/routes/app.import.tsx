import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import db from "../db.server";
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

  return { batches };
};

export default function ExcelImportPage() {
  const { batches } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Excel Import">
      <s-section heading="Import history">
        <s-text>
          Upload serialized items and products from Excel spreadsheets. Import
          writes only to the local database.
        </s-text>
        {batches.length === 0 ? (
          <s-text>No imports yet.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {batches.map((batch) => (
              <s-box
                key={batch.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-text>
                    <strong>{batch.filename}</strong>
                  </s-text>
                  <s-text>
                    {batch.successRows}/{batch.totalRows} succeeded
                  </s-text>
                  {batch.failedRows > 0 && (
                    <s-text>{batch.failedRows} failed</s-text>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
