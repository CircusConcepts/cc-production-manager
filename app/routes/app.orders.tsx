import { format } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Link,
  redirect,
  useFetcher,
  useLoaderData,
} from "react-router";

import db from "../db.server";
import {
  createOrderPdfImport,
  previewOrderPdfImport,
  readOrderPdfFromFormData,
  type OrderPdfPreview,
} from "../services/circusOrderPdfImport.server";
import { getOrCreateShop } from "../services/shop.server";
import {
  compareDueDateAsc,
  formatCalendarDate,
  formatProductLineSummary,
  formatProductionOrderStatus,
  getProductionOrderStatusOptions,
  isProductionOrderOverdue,
} from "../utils/productionOrder";
import { authenticate } from "../shopify.server";
import "../styles/production-orders.css";

type ParseActionResult = { error?: string; preview?: OrderPdfPreview };
type CreateActionResult = { error?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const orders = await db.productionOrder.findMany({
    where: { shopId: shop.id },
    include: {
      lines: {
        select: { sku: true, productName: true, quantity: true },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { documents: true } },
    },
    orderBy: [{ updatedAt: "desc" }],
  });

  return {
    statusOptions: getProductionOrderStatusOptions(),
    orders: orders
      .map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        orderDate: formatCalendarDate(order.orderDate),
        dueDate: order.dueDate ? formatCalendarDate(order.dueDate) : null,
        employee: order.employee,
        status: order.status,
        productSummary: formatProductLineSummary(order.lines),
        totalQuantity: order.lines.reduce((sum, line) => sum + line.quantity, 0),
        documentCount: order._count.documents,
        updatedAt: order.updatedAt.toISOString(),
        overdue: isProductionOrderOverdue(order.dueDate, order.status),
      }))
      .sort(compareDueDateAsc),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const manualOrderNumber = String(formData.get("orderNumber") ?? "");
  const pdfFile = readOrderPdfFromFormData(formData);

  if (intent === "parseOrderPdf") {
    if (!pdfFile) {
      return { error: "A PDF order file is required." } satisfies ParseActionResult;
    }

    const result = await previewOrderPdfImport({
      shopId: shop.id,
      manualOrderNumber,
      pdfFile,
    });

    if (!result.ok) {
      return { error: result.error } satisfies ParseActionResult;
    }

    return { preview: result.preview } satisfies ParseActionResult;
  }

  if (intent === "createOrderFromPdf") {
    if (!pdfFile) {
      return { error: "A PDF order file is required." } satisfies CreateActionResult;
    }

    try {
      const result = await createOrderPdfImport({
        shopId: shop.id,
        manualOrderNumber,
        pdfFile,
      });

      if (!result.ok) {
        return { error: result.error } satisfies CreateActionResult;
      }

      return redirect(`/app/orders/${result.order.id}?imported=1`);
    } catch {
      return {
        error: "Could not create the production order. Please try again.",
      } satisfies CreateActionResult;
    }
  }

  return { error: "Unknown action." } satisfies ParseActionResult;
};

function OrderPdfPreviewPanel({
  preview,
  onCancel,
  onCreate,
  isCreating,
}: {
  preview: OrderPdfPreview;
  onCancel: () => void;
  onCreate: () => void;
  isCreating: boolean;
}) {
  return (
    <s-section heading="Review extracted order">
      <s-stack direction="block" gap="base">
        <s-text>PDF file: {preview.pdfFilename}</s-text>
        <div className="orderDetailGrid">
          <div className="orderDetailField">
            <s-text>Order number</s-text>
            <s-text>{preview.orderNumber}</s-text>
          </div>
          <div className="orderDetailField">
            <s-text>Order date</s-text>
            <s-text>{preview.orderDate}</s-text>
          </div>
          <div className="orderDetailField">
            <s-text>Customer name</s-text>
            <s-text>{preview.customerName}</s-text>
          </div>
          <div className="orderDetailField">
            <s-text>Shipping address</s-text>
            <s-text>
              <span className="orderAddressMultiline">
                {preview.customerAddress}
              </span>
            </s-text>
          </div>
        </div>

        <div className="appTableArea">
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Quantity</s-table-header>
              <s-table-header>Color</s-table-header>
              <s-table-header>Size</s-table-header>
              <s-table-header>Other options</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {preview.lines.map((line) => (
                <s-table-row key={`${line.sku}-${line.quantity}`}>
                  <s-table-cell>{line.sku}</s-table-cell>
                  <s-table-cell>{line.productName}</s-table-cell>
                  <s-table-cell>{line.quantity}</s-table-cell>
                  <s-table-cell>{line.colorName ?? "—"}</s-table-cell>
                  <s-table-cell>{line.size ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {line.options.length > 0
                      ? line.options
                          .map((option) => `${option.label}: ${option.value}`)
                          .join("; ")
                      : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </div>

        <s-stack direction="inline" gap="base">
          <s-button
            type="button"
            variant="primary"
            onClick={onCreate}
            disabled={isCreating}
          >
            {isCreating ? "Creating order..." : "Create production order"}
          </s-button>
          <s-button type="button" variant="secondary" onClick={onCancel}>
            Cancel preview / choose another PDF
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function ProductionOrdersPage() {
  const { statusOptions, orders } = useLoaderData<typeof loader>();
  const parseFetcher = useFetcher<typeof action>();
  const createFetcher = useFetcher<typeof action>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [orderNumber, setOrderNumber] = useState("");
  const [selectedPdf, setSelectedPdf] = useState<File | null>(null);
  const [preview, setPreview] = useState<OrderPdfPreview | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const isParsing =
    parseFetcher.state !== "idle" &&
    parseFetcher.formData?.get("intent") === "parseOrderPdf";
  const isCreating =
    createFetcher.state !== "idle" &&
    createFetcher.formData?.get("intent") === "createOrderFromPdf";

  useEffect(() => {
    if (parseFetcher.data && "preview" in parseFetcher.data && parseFetcher.data.preview) {
      setPreview(parseFetcher.data.preview);
    }
  }, [parseFetcher.data]);

  const parseError =
    parseFetcher.data && "error" in parseFetcher.data
      ? parseFetcher.data.error
      : undefined;
  const createError =
    createFetcher.data && "error" in createFetcher.data
      ? createFetcher.data.error
      : undefined;

  const filteredOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter !== "ALL" && order.status !== statusFilter) {
        return false;
      }

      if (!query) return true;

      const haystack = [
        order.orderNumber,
        order.customerName,
        order.employee,
        order.productSummary,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [orders, search, statusFilter]);

  function submitPdfIntent(intent: "parseOrderPdf" | "createOrderFromPdf") {
    if (!selectedPdf) return;

    const formData = new FormData();
    formData.set("intent", intent);
    formData.set("orderNumber", orderNumber);
    formData.set("orderPdf", selectedPdf);

    const fetcher = intent === "parseOrderPdf" ? parseFetcher : createFetcher;
    fetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  }

  function resetImportForm() {
    setPreview(null);
    setSelectedPdf(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <s-page heading="Production Orders">
      <div className="appWideSection">
        {(parseError || createError) && (
          <s-banner tone="critical" heading="Could not import order">
            {parseError ?? createError}
          </s-banner>
        )}

        <s-section heading="New Production Order">
          <s-text>
            Enter the order number and upload the Circus Concepts order PDF.
            Customer, address, date, products, quantities, and recognized
            product options will be filled automatically.
          </s-text>

          {!preview ? (
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Order number"
                name="orderNumber"
                value={orderNumber}
                onInput={(event) => setOrderNumber(event.currentTarget.value)}
                autocomplete="off"
              />

              <label className="orderItemField">
                <span className="orderItemLabel">Order PDF</span>
                <input
                  ref={fileInputRef}
                  className="orderItemNativeInput"
                  type="file"
                  name="orderPdf"
                  accept=".pdf,application/pdf"
                  required
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0] ?? null;
                    setSelectedPdf(file);
                    setPreview(null);
                  }}
                />
              </label>

              <div className="orderDocumentsHelp">
                Upload one Circus Concepts order PDF with selectable text.
                Maximum 10 MB.
              </div>

              <s-button
                type="button"
                variant="primary"
                disabled={!orderNumber.trim() || !selectedPdf || isParsing}
                onClick={() => submitPdfIntent("parseOrderPdf")}
              >
                {isParsing ? "Reading order PDF..." : "Read order PDF"}
              </s-button>
            </s-stack>
          ) : (
            <OrderPdfPreviewPanel
              preview={preview}
              isCreating={isCreating}
              onCancel={resetImportForm}
              onCreate={() => submitPdfIntent("createOrderFromPdf")}
            />
          )}
        </s-section>

        <s-section heading="Production Orders">
          <div className="orderFiltersRow">
            <s-text-field
              label="Search orders"
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
              autocomplete="off"
            />
            <label className="orderItemField">
              <span className="orderItemLabel">Status</span>
              <select
                className="orderItemNativeSelect"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.currentTarget.value)}
              >
                <option value="ALL">All statuses</option>
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <s-button
              type="button"
              variant="secondary"
              onClick={() => {
                setSearch("");
                setStatusFilter("ALL");
              }}
            >
              Clear filters
            </s-button>
          </div>

          {orders.length === 0 ? (
            <s-text>
              No production orders yet. Import one from a Circus Concepts order
              PDF above.
            </s-text>
          ) : filteredOrders.length === 0 ? (
            <s-text>No production orders match your filters.</s-text>
          ) : (
            <div className="appTableArea">
              <s-table>
                <s-table-header-row>
                  <s-table-header>Order Number</s-table-header>
                  <s-table-header>Customer</s-table-header>
                  <s-table-header>Order Date</s-table-header>
                  <s-table-header>Due Date</s-table-header>
                  <s-table-header>Employee</s-table-header>
                  <s-table-header>Products</s-table-header>
                  <s-table-header>Total Quantity</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Documents</s-table-header>
                  <s-table-header>Updated</s-table-header>
                  <s-table-header>Actions</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {filteredOrders.map((order) => (
                    <s-table-row key={order.id}>
                      <s-table-cell>
                        <Link to={`/app/orders/${order.id}`}>
                          {order.orderNumber}
                        </Link>
                        {order.overdue && (
                          <div className="orderOverdueBadge">Overdue</div>
                        )}
                      </s-table-cell>
                      <s-table-cell>{order.customerName ?? "—"}</s-table-cell>
                      <s-table-cell>{order.orderDate}</s-table-cell>
                      <s-table-cell>{order.dueDate ?? "—"}</s-table-cell>
                      <s-table-cell>{order.employee ?? "—"}</s-table-cell>
                      <s-table-cell>{order.productSummary}</s-table-cell>
                      <s-table-cell>{order.totalQuantity}</s-table-cell>
                      <s-table-cell>
                        {formatProductionOrderStatus(order.status)}
                      </s-table-cell>
                      <s-table-cell>{order.documentCount}</s-table-cell>
                      <s-table-cell>
                        {format(new Date(order.updatedAt), "yyyy-MM-dd HH:mm")}
                      </s-table-cell>
                      <s-table-cell>
                        <Link to={`/app/orders/${order.id}`}>View / Edit</Link>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>
          )}
        </s-section>
      </div>
    </s-page>
  );
}
