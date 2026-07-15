import { format } from "date-fns";
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { ProductionOrderItemsEditor } from "../components/ProductionOrderItemsEditor";
import db from "../db.server";
import { validateOrderDocumentUploads } from "../services/orderDocumentStorage.server";
import {
  collectDocumentFiles,
  createProductionOrderWithLines,
  getDistinctEmployeeNames,
  parseOrderItemsJson,
  resolveOrderLinesForShop,
  validateProductionOrderForm,
} from "../services/productionOrder.server";
import { getOrCreateShop } from "../services/shop.server";
import {
  compareDueDateAsc,
  formatCalendarDate,
  formatProductLineSummary,
  formatProductionOrderStatus,
  getProductionOrderStatusOptions,
  getTodayCalendarDate,
  isProductionOrderOverdue,
} from "../utils/productionOrder";
import { authenticate } from "../shopify.server";
import "../styles/production-orders.css";

type ActionResult = { error?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const [products, colors, employeeNames, orders] = await Promise.all([
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
    db.productionOrder.findMany({
      where: { shopId: shop.id },
      include: {
        lines: {
          select: { sku: true, productName: true, quantity: true },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { documents: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
    }),
  ]);

  return {
    products,
    colors,
    employeeNames,
    statusOptions: getProductionOrderStatusOptions(),
    today: getTodayCalendarDate(),
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

  if (intent !== "createOrder") {
    return { error: "Unknown action." } satisfies ActionResult;
  }

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

  const resolvedLines = await resolveOrderLinesForShop({
    shopId: shop.id,
    items: validation.data.items,
  });
  if (!resolvedLines.ok) {
    return { error: resolvedLines.error } satisfies ActionResult;
  }

  const documentFiles = collectDocumentFiles(formData);
  const documentValidation = await validateOrderDocumentUploads(documentFiles);
  if (!documentValidation.ok) {
    return { error: documentValidation.error } satisfies ActionResult;
  }

  try {
    const result = await createProductionOrderWithLines({
      shopId: shop.id,
      orderData: validation.data,
      lines: resolvedLines.lines,
      documents: documentValidation.documents,
    });

    if (!result.ok) {
      return { error: result.error } satisfies ActionResult;
    }

    return redirect(`/app/orders/${result.order.id}`);
  } catch {
    return {
      error: "Could not create the production order. Please try again.",
    } satisfies ActionResult;
  }
};

export default function ProductionOrdersPage() {
  const { products, colors, employeeNames, statusOptions, orders, today } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "createOrder";

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

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

  return (
    <s-page heading="Production Orders">
      <div className="appWideSection">
        {actionData?.error && (
          <s-banner tone="critical" heading="Could not save order">
            {actionData.error}
          </s-banner>
        )}

        <s-section heading="New Production Order">
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="createOrder" />

            <s-stack direction="block" gap="base">
              <div className="orderFormGrid">
                <s-text-field
                  label="Order number"
                  name="orderNumber"
                  required
                  autocomplete="off"
                />
                <s-text-field
                  label="Customer name"
                  name="customerName"
                  required
                  autocomplete="off"
                />
                <s-text-field
                  label="Customer address"
                  name="customerAddress"
                  autocomplete="off"
                />
                <label className="orderItemField">
                  <span className="orderItemLabel">Order date</span>
                  <input
                    className="orderItemNativeInput"
                    type="date"
                    name="orderDate"
                    defaultValue={today}
                    required
                  />
                </label>
                <label className="orderItemField">
                  <span className="orderItemLabel">Due date</span>
                  <input
                    className="orderItemNativeInput"
                    type="date"
                    name="dueDate"
                    required
                  />
                </label>
                <label className="orderItemField">
                  <span className="orderItemLabel">Employee</span>
                  <input
                    className="orderItemNativeInput"
                    type="text"
                    name="employee"
                    list="employee-suggestions"
                    autoComplete="off"
                  />
                </label>
                <datalist id="employee-suggestions">
                  {employeeNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <label className="orderItemField">
                  <span className="orderItemLabel">Status</span>
                  <select
                    className="orderItemNativeSelect"
                    name="status"
                    defaultValue="OPEN"
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
                autocomplete="off"
              />

              <s-section heading="Order items">
                {products.length === 0 ? (
                  <s-text>
                    Add active products on the Products page before creating an
                    order.
                  </s-text>
                ) : (
                  <ProductionOrderItemsEditor
                    products={products}
                    colors={colors}
                  />
                )}
              </s-section>

              <s-section heading="Order Documents">
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
              </s-section>

              <s-button
                type="submit"
                variant="primary"
                disabled={products.length === 0 || isSubmitting}
              >
                {isSubmitting ? "Saving order..." : "Create production order"}
              </s-button>
            </s-stack>
          </Form>
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
            <s-text>No production orders yet. Create one above.</s-text>
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
