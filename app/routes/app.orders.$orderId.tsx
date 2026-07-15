import { format } from "date-fns";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { ProductionOrderItemsEditor } from "../components/ProductionOrderItemsEditor";
import {
  collectDocumentFiles,
  deleteProductionOrderDocument,
  findProductionOrderForShop,
  getDistinctEmployeeNames,
  parseOrderItemsJson,
  updateProductionOrderWithLines,
  uploadProductionOrderDocuments,
  validateProductionOrderForm,
} from "../services/productionOrder.server";
import { getOrCreateShop } from "../services/shop.server";
import {
  formatCalendarDate,
  formatProductionOrderStatus,
  getProductionOrderStatusOptions,
  getTodayCalendarDate,
  isProductionOrderOverdue,
  sanitizeDisplayFilename,
  type ProductionOrderItemInput,
} from "../utils/productionOrder";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import "../styles/production-orders.css";

type ActionResult = { error?: string; success?: string };

type LineCustomProperties = {
  source?: string;
  pdfDescription?: string;
  pdfModel?: string;
  options?: Array<{ label: string; value: string }>;
};

function formatLineOptions(customProperties: unknown): string {
  if (!customProperties || typeof customProperties !== "object") {
    return "—";
  }

  const props = customProperties as LineCustomProperties;
  if (!props.options || props.options.length === 0) {
    return "—";
  }

  return props.options
    .map((option) => `${option.label}: ${option.value}`)
    .join("; ");
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const orderId = params.orderId;

  if (!orderId) {
    throw new Response("Not found", { status: 404 });
  }

  const order = await findProductionOrderForShop({ shopId: shop.id, orderId });
  if (!order) {
    throw new Response("Not found", { status: 404 });
  }

  const [products, colors, employeeNames] = await Promise.all([
    db.product.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sku: "asc" }, { name: "asc" }],
      select: { id: true, sku: true, name: true },
    }),
    db.color.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getDistinctEmployeeNames(shop.id),
  ]);

  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName ?? "",
      customerAddress: order.customerAddress ?? "",
      orderNote: order.orderNote ?? "",
      orderDate: formatCalendarDate(order.orderDate),
      dueDate: order.dueDate ? formatCalendarDate(order.dueDate) : "",
      employee: order.employee ?? "",
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      overdue: isProductionOrderOverdue(order.dueDate, order.status),
      lines: order.lines.map((line) => ({
        id: line.id,
        productId: line.productId ?? "",
        sku: line.sku,
        productName: line.productName,
        quantity: line.quantity,
        colorId: line.colorId ?? "",
        colorName: line.colorName,
        size: line.size ?? "",
        linkedItemCount: line._count.items,
        customProperties: line.customProperties,
      })),
      documents: order.documents.map((document) => ({
        id: document.id,
        originalName: sanitizeDisplayFilename(document.originalName),
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        createdAt: document.createdAt.toISOString(),
      })),
    },
    products,
    colors,
    employeeNames,
    statusOptions: getProductionOrderStatusOptions(),
    today: getTodayCalendarDate(),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const orderId = params.orderId;

  if (!orderId) {
    return { error: "Production order not found." } satisfies ActionResult;
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "updateOrder") {
    const itemsResult = parseOrderItemsJson(
      String(formData.get("orderItemsJson") ?? "[]"),
    );
    if (!itemsResult.ok) {
      return { error: itemsResult.error } satisfies ActionResult;
    }

    const validation = validateProductionOrderForm(
      {
        orderNumber: String(formData.get("orderNumber") ?? ""),
        customerName: String(formData.get("customerName") ?? ""),
        customerAddress: String(formData.get("customerAddress") ?? ""),
        orderNote: String(formData.get("orderNote") ?? ""),
        orderDate: String(formData.get("orderDate") ?? ""),
        dueDate: String(formData.get("dueDate") ?? ""),
        employee: String(formData.get("employee") ?? ""),
        status: String(formData.get("status") ?? ""),
      },
      itemsResult.items,
    );

    if (!validation.ok) {
      return { error: validation.error } satisfies ActionResult;
    }

    try {
      const result = await updateProductionOrderWithLines({
        shopId: shop.id,
        orderId,
        orderData: validation.data,
        items: itemsResult.items,
      });

      if (!result.ok) {
        return { error: result.error } satisfies ActionResult;
      }

      return { success: "Production order updated." } satisfies ActionResult;
    } catch {
      return {
        error: "Could not update the production order. Please try again.",
      } satisfies ActionResult;
    }
  }

  if (intent === "uploadDocuments") {
    const files = collectDocumentFiles(formData);
    if (files.length === 0) {
      return { error: "Select at least one document to upload." } satisfies ActionResult;
    }

    try {
      const result = await uploadProductionOrderDocuments({
        shopId: shop.id,
        orderId,
        files,
      });
      if (!result.ok) {
        return { error: result.error } satisfies ActionResult;
      }
      return { success: "Documents uploaded." } satisfies ActionResult;
    } catch {
      return {
        error: "Could not upload documents. Please try again.",
      } satisfies ActionResult;
    }
  }

  if (intent === "deleteDocument") {
    const documentId = String(formData.get("documentId") ?? "").trim();
    if (!documentId) {
      return { error: "Document not found." } satisfies ActionResult;
    }

    const result = await deleteProductionOrderDocument({
      shopId: shop.id,
      orderId,
      documentId,
    });

    if (!result.ok) {
      return { error: result.error } satisfies ActionResult;
    }

    return { success: "Document deleted." } satisfies ActionResult;
  }

  return { error: "Unknown action." } satisfies ActionResult;
};

export default function ProductionOrderDetailPage() {
  const { order, products, colors, employeeNames, statusOptions } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(false);
  const importedFromPdf = searchParams.get("imported") === "1";

  const isSavingOrder =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "updateOrder";
  const isUploadingDocuments =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "uploadDocuments";

  const initialItems: ProductionOrderItemInput[] = order.lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    quantity: line.quantity,
    colorId: line.colorId,
    size: line.size,
  }));

  return (
    <s-page heading={`Order ${order.orderNumber}`}>
      <div className="appWideSection">
        <s-link href="/app/orders">Back to production orders</s-link>

        {actionData?.error && (
          <s-banner tone="critical" heading="Action failed">
            {actionData.error}
          </s-banner>
        )}
        {actionData?.success && (
          <s-banner tone="success" heading="Saved">
            {actionData.success}
          </s-banner>
        )}

        {importedFromPdf && (
          <s-banner tone="success" heading="Order imported from PDF">
            Review the extracted details and update the due date or employee when
            needed.
          </s-banner>
        )}

        {order.overdue && (
          <s-banner tone="warning" heading="Overdue order">
            This order is past its due date and is not marked done or cancelled.
          </s-banner>
        )}

        <s-section heading="Order details">
          <s-stack direction="inline" gap="base">
            <s-button
              type="button"
              variant={isEditing ? "primary" : "secondary"}
              onClick={() => setIsEditing((current) => !current)}
            >
              {isEditing ? "Cancel edit" : "Edit order"}
            </s-button>
          </s-stack>

          {isEditing ? (
            <Form method="post">
              <input type="hidden" name="intent" value="updateOrder" />
              <s-stack direction="block" gap="base">
                <div className="orderFormGrid">
                  <s-text-field
                    label="Order number"
                    name="orderNumber"
                    defaultValue={order.orderNumber}
                    required
                    autocomplete="off"
                  />
                  <s-text-field
                    label="Customer name"
                    name="customerName"
                    defaultValue={order.customerName}
                    required
                    autocomplete="off"
                  />
                  <s-text-field
                    label="Customer address"
                    name="customerAddress"
                    defaultValue={order.customerAddress}
                    autocomplete="off"
                  />
                  <label className="orderItemField">
                    <span className="orderItemLabel">Order date</span>
                    <input
                      className="orderItemNativeInput"
                      type="date"
                      name="orderDate"
                      defaultValue={order.orderDate}
                      required
                    />
                  </label>
                  <label className="orderItemField">
                    <span className="orderItemLabel">Due date</span>
                    <input
                      className="orderItemNativeInput"
                      type="date"
                      name="dueDate"
                      defaultValue={order.dueDate}
                    />
                  </label>
                  <label className="orderItemField">
                    <span className="orderItemLabel">Employee</span>
                    <input
                      className="orderItemNativeInput"
                      type="text"
                      name="employee"
                      defaultValue={order.employee}
                      list="employee-suggestions-detail"
                      autoComplete="off"
                    />
                  </label>
                  <datalist id="employee-suggestions-detail">
                    {employeeNames.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <label className="orderItemField">
                    <span className="orderItemLabel">Status</span>
                    <select
                      className="orderItemNativeSelect"
                      name="status"
                      defaultValue={order.status}
                      required
                    >
                      {statusOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <s-text-field
                  label="Order note"
                  name="orderNote"
                  defaultValue={order.orderNote}
                  autocomplete="off"
                />

                <s-section heading="Order items">
                  <ProductionOrderItemsEditor
                    products={products}
                    colors={colors}
                    initialItems={initialItems}
                  />
                </s-section>

                <s-button
                  type="submit"
                  variant="primary"
                  disabled={isSavingOrder}
                >
                  {isSavingOrder ? "Saving changes..." : "Save changes"}
                </s-button>
              </s-stack>
            </Form>
          ) : (
            <div className="orderDetailGrid">
              <div className="orderDetailField">
                <s-text>Order number</s-text>
                <s-text>{order.orderNumber}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Customer name</s-text>
                <s-text>{order.customerName || "—"}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Customer address</s-text>
                <s-text>
                  <span className="orderAddressMultiline">
                    {order.customerAddress || "—"}
                  </span>
                </s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Order date</s-text>
                <s-text>{order.orderDate}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Due date</s-text>
                <s-text>{order.dueDate || "—"}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Employee</s-text>
                <s-text>{order.employee || "—"}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Status</s-text>
                <s-text>{formatProductionOrderStatus(order.status)}</s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Created</s-text>
                <s-text>
                  {format(new Date(order.createdAt), "yyyy-MM-dd HH:mm")}
                </s-text>
              </div>
              <div className="orderDetailField">
                <s-text>Updated</s-text>
                <s-text>
                  {format(new Date(order.updatedAt), "yyyy-MM-dd HH:mm")}
                </s-text>
              </div>
            </div>
          )}

          {!isEditing && order.orderNote && (
            <s-section heading="Order note">
              <s-text>{order.orderNote}</s-text>
            </s-section>
          )}
        </s-section>

        {!isEditing && (
          <s-section heading="Product lines">
            <div className="appTableArea">
              <s-table>
                <s-table-header-row>
                  <s-table-header>SKU</s-table-header>
                  <s-table-header>Product</s-table-header>
                  <s-table-header>Quantity</s-table-header>
                  <s-table-header>Color</s-table-header>
                  <s-table-header>Size</s-table-header>
                  <s-table-header>Options</s-table-header>
                  <s-table-header>Linked items</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {order.lines.map((line) => (
                    <s-table-row key={line.id}>
                      <s-table-cell>{line.sku ?? "—"}</s-table-cell>
                      <s-table-cell>{line.productName}</s-table-cell>
                      <s-table-cell>{line.quantity}</s-table-cell>
                      <s-table-cell>{line.colorName ?? "—"}</s-table-cell>
                      <s-table-cell>{line.size || "—"}</s-table-cell>
                      <s-table-cell>
                        {formatLineOptions(line.customProperties)}
                      </s-table-cell>
                      <s-table-cell>{line.linkedItemCount}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>
          </s-section>
        )}

        <s-section heading="Documents">
          {order.documents.length === 0 ? (
            <s-text>No documents uploaded yet.</s-text>
          ) : (
            <div className="orderDocumentList">
              {order.documents.map((document) => (
                <div key={document.id} className="orderDocumentRow">
                  <Link
                    to={`/app/orders/${order.id}/documents/${document.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View {document.originalName}
                  </Link>
                  <Link
                    to={`/app/orders/${order.id}/documents/${document.id}?download=1`}
                    reloadDocument
                  >
                    Download {document.originalName}
                  </Link>
                  <Form
                    method="post"
                    onSubmit={(event) => {
                      if (
                        !confirm(
                          `Delete document "${document.originalName}"? This cannot be undone.`,
                        )
                      ) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="deleteDocument" />
                    <input type="hidden" name="documentId" value={document.id} />
                    <s-button type="submit" variant="tertiary" tone="critical">
                      Delete {document.originalName}
                    </s-button>
                  </Form>
                </div>
              ))}
            </div>
          )}

          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="uploadDocuments" />
            <s-stack direction="block" gap="base">
              <input
                type="file"
                name="documents"
                multiple
                accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
              />
              <div className="orderDocumentsHelp">
                Accepted files: JPG, PNG, WebP, PDF. Maximum 10 MB per file.
                Maximum 10 documents per order. Combined upload limit is 50 MB.
              </div>
              <s-button
                type="submit"
                variant="secondary"
                disabled={isUploadingDocuments}
              >
                {isUploadingDocuments ? "Uploading..." : "Upload documents"}
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      </div>
    </s-page>
  );
}
