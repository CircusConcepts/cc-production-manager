import { Prisma } from "@prisma/client";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import db from "../db.server";
import { createAuditLog } from "../services/audit.server";
import { getOrCreateShop } from "../services/shop.server";
import { ITEM_STATUSES, SOURCE_TYPES, isItemStatus, isSourceType } from "../utils/itemConstants";
import { formatSourceType, formatStatus } from "../utils/labels";
import {
  isStockOrderNumber,
  resolveStatusForOrderNumber,
} from "../utils/itemStatus";
import { authenticate } from "../shopify.server";

const CATEGORY_ALL = "__all__";
const CATEGORY_UNCATEGORIZED = "__uncategorized__";

function productMatchesCategory(
  product: { category: string | null },
  categoryFilter: string,
): boolean {
  if (categoryFilter === CATEGORY_ALL) return true;
  if (categoryFilter === CATEGORY_UNCATEGORIZED) return !product.category?.trim();
  return product.category?.trim() === categoryFilter;
}

function buildItemsUrl({
  category,
  productId,
}: {
  category: string;
  productId?: string;
}) {
  const params = new URLSearchParams();
  if (category !== CATEGORY_ALL) params.set("category", category);
  if (productId) params.set("productId", productId);
  const query = params.toString();
  return query ? `/app/items?${query}` : "/app/items";
}

function formatProductOptionLabel(product: {
  sku: string;
  name: string;
  active: boolean;
  _count: { items: number };
}): string {
  const inactiveSuffix = product.active ? "" : " [inactive]";
  return `${product.sku} — ${product.name} (${product._count.items} items)${inactiveSuffix}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  const products = await db.product.findMany({
    where: { shopId: shop.id, active: true },
    orderBy: { sku: "asc" },
    select: {
      id: true,
      sku: true,
      name: true,
      category: true,
      active: true,
      _count: { select: { items: true } },
    },
  });

  let selectedProduct: {
    id: string;
    sku: string;
    name: string;
  } | null = null;

  let items: Array<{
    id: string;
    serialNumber: string;
    status: string;
    sourceType: string;
    orderNumber: string | null;
    color: string | null;
    size: string | null;
    madeBy: string | null;
    notes: string | null;
    updatedAt: string;
  }> = [];

  if (productId) {
    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
      select: { id: true, sku: true, name: true },
    });

    if (product) {
      selectedProduct = product;
      const rows = await db.serializedItem.findMany({
        where: { shopId: shop.id, productId: product.id },
        orderBy: { updatedAt: "desc" },
      });

      items = rows.map((item) => ({
        id: item.id,
        serialNumber: item.serialNumber,
        status: item.status,
        sourceType: item.sourceType,
        orderNumber: item.orderNumber,
        color: item.color,
        size: item.size,
        madeBy: item.madeBy,
        notes: item.notes,
        updatedAt: item.updatedAt.toISOString(),
      }));
    }
  }

  return { products, selectedProduct, items, statuses: ITEM_STATUSES };
};

async function getProductForShop(shopId: string, productId: string) {
  return db.product.findFirst({
    where: { id: productId, shopId },
    select: { id: true, sku: true, name: true },
  });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const productId = String(formData.get("productId") ?? "").trim();

  if (!productId) {
    return { error: "Product selection is required." };
  }

  const product = await getProductForShop(shop.id, productId);
  if (!product) {
    return { error: "Product not found." };
  }

  if (intent === "create") {
    const serialNumber = String(formData.get("serialNumber") ?? "").trim();
    const statusInput = String(formData.get("status") ?? "IN_STOCK");
    const sourceType = String(formData.get("sourceType") ?? "STOCK");
    const orderNumber = String(formData.get("orderNumber") ?? "").trim();
    const color = String(formData.get("color") ?? "").trim();
    const size = String(formData.get("size") ?? "").trim();
    const madeBy = String(formData.get("madeBy") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();

    if (!serialNumber) return { error: "Serial number is required." };
    if (!isItemStatus(statusInput)) return { error: "Invalid status." };
    if (!isSourceType(sourceType)) return { error: "Invalid source type." };

    const status = resolveStatusForOrderNumber({
      orderNumber: orderNumber || null,
      requestedStatus: statusInput,
    });

    try {
      const item = await db.serializedItem.create({
        data: {
          shopId: shop.id,
          productId: product.id,
          serialNumber,
          status,
          sourceType,
          orderNumber: orderNumber || null,
          color: color || null,
          size: size || null,
          madeBy: madeBy || null,
          notes: notes || null,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "serialized_item.created",
        entity: "SerializedItem",
        entityId: item.id,
        metadata: {
          serialNumber,
          sku: product.sku,
          status,
          sourceType,
          color,
          size,
          employee: madeBy,
        },
      });

      return { success: `Item "${serialNumber}" created.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `Serial number "${serialNumber}" already exists for this shop.`,
        };
      }
      throw error;
    }
  }

  if (intent === "updateStatus") {
    const itemId = String(formData.get("itemId") ?? "");
    const statusInput = String(formData.get("status") ?? "");

    if (!isItemStatus(statusInput)) {
      return { error: "Invalid status." };
    }

    const item = await db.serializedItem.findFirst({
      where: { id: itemId, shopId: shop.id, productId: product.id },
      include: { product: { select: { sku: true, name: true } } },
    });

    if (!item) return { error: "Item not found." };

    const status = resolveStatusForOrderNumber({
      orderNumber: item.orderNumber,
      requestedStatus: statusInput,
    });

    if (item.status === status) {
      return { success: `Item "${item.serialNumber}" is already ${formatStatus(status)}.` };
    }

    const previousStatus = item.status;

    await db.serializedItem.update({
      where: { id: item.id },
      data: { status },
    });

    await createAuditLog({
      shopId: shop.id,
      action: "item.status_updated",
      entity: "SerializedItem",
      entityId: item.id,
      metadata: {
        serialNumber: item.serialNumber,
        sku: item.product.sku,
        from: previousStatus,
        to: status,
      },
    });

    return { success: `Item "${item.serialNumber}" updated to ${formatStatus(status)}.` };
  }

  if (intent === "updateItem") {
    const itemId = String(formData.get("itemId") ?? "");
    const serialNumber = String(formData.get("serialNumber") ?? "").trim();
    const statusInput = String(formData.get("status") ?? "IN_STOCK");
    const sourceType = String(formData.get("sourceType") ?? "STOCK");
    const orderNumber = String(formData.get("orderNumber") ?? "").trim();
    const color = String(formData.get("color") ?? "").trim();
    const size = String(formData.get("size") ?? "").trim();
    const madeBy = String(formData.get("madeBy") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();

    if (!serialNumber) return { error: "Serial number is required." };
    if (!isItemStatus(statusInput)) return { error: "Invalid status." };
    if (!isSourceType(sourceType)) return { error: "Invalid source type." };

    const item = await db.serializedItem.findFirst({
      where: { id: itemId, shopId: shop.id, productId: product.id },
      include: { product: { select: { sku: true, name: true } } },
    });

    if (!item) return { error: "Item not found." };

    const status = resolveStatusForOrderNumber({
      orderNumber: orderNumber || null,
      requestedStatus: statusInput,
    });

    const before = {
      serialNumber: item.serialNumber,
      status: item.status,
      sourceType: item.sourceType,
      orderNumber: item.orderNumber,
      color: item.color,
      size: item.size,
      madeBy: item.madeBy,
      notes: item.notes,
    };

    try {
      await db.serializedItem.update({
        where: { id: item.id },
        data: {
          serialNumber,
          status,
          sourceType,
          orderNumber: orderNumber || null,
          color: color || null,
          size: size || null,
          madeBy: madeBy || null,
          notes: notes || null,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "serialized_item.updated",
        entity: "SerializedItem",
        entityId: item.id,
        metadata: {
          sku: item.product.sku,
          before,
          after: {
            serialNumber,
            status,
            sourceType,
            orderNumber: orderNumber || null,
            color: color || null,
            size: size || null,
            madeBy: madeBy || null,
            notes: notes || null,
          },
        },
      });

      return { success: `Item "${serialNumber}" updated.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `Serial number "${serialNumber}" already exists for this shop.`,
        };
      }
      throw error;
    }
  }

  if (intent === "deleteItem") {
    const itemId = String(formData.get("itemId") ?? "");

    const item = await db.serializedItem.findFirst({
      where: { id: itemId, shopId: shop.id, productId: product.id },
      include: { product: { select: { sku: true, name: true } } },
    });

    if (!item) return { error: "Item not found." };

    await createAuditLog({
      shopId: shop.id,
      action: "serialized_item.deleted",
      entity: "SerializedItem",
      entityId: item.id,
      metadata: {
        serialNumber: item.serialNumber,
        sku: item.product.sku,
        productName: item.product.name,
        orderNumber: item.orderNumber,
        color: item.color,
        size: item.size,
        employee: item.madeBy,
        previousStatus: item.status,
      },
    });

    await db.serializedItem.delete({ where: { id: item.id } });

    return { success: `Local item "${item.serialNumber}" deleted.` };
  }

  return { error: "Unknown action." };
};

function matchesItemSearch(
  item: {
    serialNumber: string;
    orderNumber: string | null;
    status: string;
    sourceType: string;
    color: string | null;
    size: string | null;
    madeBy: string | null;
    notes: string | null;
  },
  query: string,
): boolean {
  const q = query.toLowerCase();
  const haystack = [
    item.serialNumber,
    item.orderNumber,
    formatStatus(item.status as never),
    formatSourceType(item.sourceType as never),
    item.color,
    item.size,
    item.madeBy,
    item.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(q);
}

export default function ListsPage() {
  const { products, selectedProduct, items, statuses } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const productId = searchParams.get("productId") ?? "";
  const categoryParam = searchParams.get("category") ?? CATEGORY_ALL;

  const [itemSearch, setItemSearch] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState("IN_STOCK");
  const [editSourceType, setEditSourceType] = useState("STOCK");
  const [createOrderNumber, setCreateOrderNumber] = useState("");
  const [createStatus, setCreateStatus] = useState("IN_STOCK");
  const createIsStock = isStockOrderNumber(createOrderNumber);

  const categoryOptions = useMemo(() => {
    const named = new Set<string>();
    let hasUncategorized = false;

    for (const product of products) {
      if (product.category?.trim()) {
        named.add(product.category.trim());
      } else {
        hasUncategorized = true;
      }
    }

    return {
      named: [...named].sort((a, b) => a.localeCompare(b)),
      hasUncategorized,
    };
  }, [products]);

  const filteredProducts = useMemo(
    () => products.filter((product) => productMatchesCategory(product, categoryParam)),
    [products, categoryParam],
  );

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim();
    if (!q) return items;
    return items.filter((item) => matchesItemSearch(item, q));
  }, [items, itemSearch]);

  const handleCategoryChange = (value: string) => {
    const currentProduct = products.find((product) => product.id === productId);
    const keepProductId =
      currentProduct && productMatchesCategory(currentProduct, value)
        ? productId
        : undefined;

    navigate(buildItemsUrl({ category: value, productId: keepProductId }));
  };

  const handleProductChange = (value: string) => {
    navigate(
      buildItemsUrl({
        category: categoryParam,
        productId: value || undefined,
      }),
    );
  };

  return (
    <s-page heading="Lists">
      {actionData?.error && (
        <s-banner tone="critical" heading="Could not save">
          {actionData.error}
        </s-banner>
      )}
      {actionData?.success && (
        <s-banner tone="success" heading="Saved">
          {actionData.success}
        </s-banner>
      )}

      <s-section heading="Select product">
        <s-text>
          Choose a product to manage its list items. All changes are saved only
          in this app database — never in Shopify.
        </s-text>

        {products.length === 0 ? (
          <s-text>
            Add a product first on the Products page, then you can register list
            items here.
          </s-text>
        ) : (
          <s-stack direction="block" gap="base">
            <s-select
              label="Product category"
              value={categoryParam}
              onChange={(e) => handleCategoryChange(e.currentTarget.value)}
            >
              <s-option value={CATEGORY_ALL}>All categories</s-option>
              {categoryOptions.named.map((category) => (
                <s-option key={category} value={category}>
                  {category}
                </s-option>
              ))}
              {categoryOptions.hasUncategorized && (
                <s-option value={CATEGORY_UNCATEGORIZED}>Uncategorized</s-option>
              )}
            </s-select>

            <s-select
              label="Product"
              value={productId}
              onChange={(e) => handleProductChange(e.currentTarget.value)}
            >
              <s-option value="">Select a product</s-option>
              {filteredProducts.map((product) => (
                <s-option key={product.id} value={product.id}>
                  {formatProductOptionLabel(product)}
                </s-option>
              ))}
            </s-select>
          </s-stack>
        )}
      </s-section>

      {selectedProduct && (
        <>
          <s-section
            heading={`Add item for ${selectedProduct.sku} — ${selectedProduct.name}`}
          >
            <Form method="post">
              <input type="hidden" name="intent" value="create" />
              <input type="hidden" name="productId" value={selectedProduct.id} />
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="serialNumber"
                  label="Serial number"
                  required
                  autocomplete="off"
                />
                <s-text-field
                  name="orderNumber"
                  label="Order number"
                  value={createOrderNumber}
                  onInput={(e) => setCreateOrderNumber(e.currentTarget.value)}
                  autocomplete="off"
                />
                {createIsStock && (
                  <s-text>
                    Auto-set because Order # is Stock — status will be In stock.
                  </s-text>
                )}
                <s-select
                  name="status"
                  label="Status"
                  value={createIsStock ? "IN_STOCK" : createStatus}
                  disabled={createIsStock}
                  onChange={(e) => setCreateStatus(e.currentTarget.value)}
                >
                  {statuses.map((status) => (
                    <s-option key={status} value={status}>
                      {formatStatus(status)}
                    </s-option>
                  ))}
                </s-select>
                <s-select name="sourceType" label="Where it came from" value="STOCK">
                  {SOURCE_TYPES.map((sourceType) => (
                    <s-option key={sourceType} value={sourceType}>
                      {formatSourceType(sourceType)}
                    </s-option>
                  ))}
                </s-select>
                <s-text-field name="color" label="Color" autocomplete="off" />
                <s-text-field name="size" label="Size" autocomplete="off" />
                <s-text-field name="madeBy" label="Employee" autocomplete="off" />
                <s-text-area name="notes" label="Notes" />
                <s-button type="submit" variant="primary">
                  Create item
                </s-button>
              </s-stack>
            </Form>
          </s-section>

          <s-section
            heading={`Items for ${selectedProduct.sku} — ${selectedProduct.name} (${filteredItems.length})`}
          >
            <s-text-field
              label="Search items"
              value={itemSearch}
              onInput={(e) => setItemSearch(e.currentTarget.value)}
              autocomplete="off"
            />

            {editingItemId && (() => {
              const editingItem = items.find((item) => item.id === editingItemId);
              if (!editingItem) return null;
              const editStockOrder = isStockOrderNumber(editingItem.orderNumber);

              return (
                <s-section heading={`Edit item ${editingItem.serialNumber}`}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="updateItem" />
                    <input type="hidden" name="productId" value={selectedProduct.id} />
                    <input type="hidden" name="itemId" value={editingItem.id} />
                    <s-stack direction="block" gap="base">
                      <s-text-field
                        name="serialNumber"
                        label="Serial number"
                        defaultValue={editingItem.serialNumber}
                        required
                        autocomplete="off"
                      />
                      <s-text-field
                        name="orderNumber"
                        label="Order number"
                        defaultValue={editingItem.orderNumber ?? ""}
                        autocomplete="off"
                      />
                      <s-select
                        name="status"
                        label="Status"
                        value={editStockOrder ? "IN_STOCK" : editStatus}
                        disabled={editStockOrder}
                        onChange={(e) => setEditStatus(e.currentTarget.value)}
                      >
                        {statuses.map((status) => (
                          <s-option key={status} value={status}>
                            {formatStatus(status)}
                          </s-option>
                        ))}
                      </s-select>
                      <s-select
                        name="sourceType"
                        label="Source"
                        value={editSourceType}
                        onChange={(e) => setEditSourceType(e.currentTarget.value)}
                      >
                        {SOURCE_TYPES.map((sourceType) => (
                          <s-option key={sourceType} value={sourceType}>
                            {formatSourceType(sourceType)}
                          </s-option>
                        ))}
                      </s-select>
                      <s-text-field
                        name="color"
                        label="Color"
                        defaultValue={editingItem.color ?? ""}
                        autocomplete="off"
                      />
                      <s-text-field
                        name="size"
                        label="Size"
                        defaultValue={editingItem.size ?? ""}
                        autocomplete="off"
                      />
                      <s-text-field
                        name="madeBy"
                        label="Employee"
                        defaultValue={editingItem.madeBy ?? ""}
                        autocomplete="off"
                      />
                      <s-text-area
                        name="notes"
                        label="Notes"
                        defaultValue={editingItem.notes ?? ""}
                      />
                      <s-stack direction="inline" gap="base">
                        <s-button type="submit" variant="primary">
                          Save
                        </s-button>
                        <s-button
                          type="button"
                          variant="secondary"
                          onClick={() => {
                            setEditingItemId(null);
                            setEditStatus("IN_STOCK");
                            setEditSourceType("STOCK");
                          }}
                        >
                          Cancel
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </Form>
                </s-section>
              );
            })()}

            {filteredItems.length === 0 ? (
              <s-text>No list items for this product yet.</s-text>
            ) : (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Serial Number</s-table-header>
                  <s-table-header>Status</s-table-header>
                  <s-table-header>Source</s-table-header>
                  <s-table-header>Order #</s-table-header>
                  <s-table-header>Color</s-table-header>
                  <s-table-header>Size</s-table-header>
                  <s-table-header>Employee</s-table-header>
                  <s-table-header>Notes</s-table-header>
                  <s-table-header>Updated</s-table-header>
                  <s-table-header>Update Status</s-table-header>
                  <s-table-header>Edit</s-table-header>
                  <s-table-header>Delete</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {filteredItems.map((item) => {
                    const stockOrder = isStockOrderNumber(item.orderNumber);

                    return (
                      <s-table-row key={item.id}>
                        <s-table-cell>{item.serialNumber}</s-table-cell>
                        <s-table-cell>{formatStatus(item.status as never)}</s-table-cell>
                        <s-table-cell>{formatSourceType(item.sourceType as never)}</s-table-cell>
                        <s-table-cell>{item.orderNumber ?? "—"}</s-table-cell>
                        <s-table-cell>{item.color ?? "—"}</s-table-cell>
                        <s-table-cell>{item.size ?? "—"}</s-table-cell>
                        <s-table-cell>{item.madeBy ?? "—"}</s-table-cell>
                        <s-table-cell>{item.notes ?? "—"}</s-table-cell>
                        <s-table-cell>
                          {format(new Date(item.updatedAt), "MMM d, yyyy HH:mm")}
                        </s-table-cell>
                        <s-table-cell>
                          {stockOrder ? (
                            <s-stack direction="block" gap="base">
                              <s-text>In stock</s-text>
                              <s-text>
                                Auto-set because Order # is Stock
                              </s-text>
                            </s-stack>
                          ) : (
                            <Form method="post">
                              <input type="hidden" name="intent" value="updateStatus" />
                              <input type="hidden" name="productId" value={selectedProduct.id} />
                              <input type="hidden" name="itemId" value={item.id} />
                              <s-stack direction="inline" gap="base">
                                <s-select
                                  name="status"
                                  label="Status"
                                  labelAccessibilityVisibility="exclusive"
                                  value={item.status}
                                >
                                  {statuses.map((status) => (
                                    <s-option key={status} value={status}>
                                      {formatStatus(status)}
                                    </s-option>
                                  ))}
                                </s-select>
                                <s-button type="submit" variant="secondary">
                                  Update
                                </s-button>
                              </s-stack>
                            </Form>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          <s-button
                            type="button"
                            variant="secondary"
                            onClick={() => {
                            setEditingItemId(item.id);
                            setEditStatus(item.status);
                            setEditSourceType(item.sourceType);
                          }}
                          >
                            Edit
                          </s-button>
                        </s-table-cell>
                        <s-table-cell>
                          <Form
                            method="post"
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  "Delete this local item from the app database? This does not affect Shopify.",
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input type="hidden" name="intent" value="deleteItem" />
                            <input type="hidden" name="productId" value={selectedProduct.id} />
                            <input type="hidden" name="itemId" value={item.id} />
                            <s-button type="submit" variant="secondary">
                              Delete item
                            </s-button>
                          </Form>
                        </s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            )}
          </s-section>
        </>
      )}

      {!selectedProduct && productId && (
        <s-banner tone="warning" heading="Product not found">
          The selected product was not found for this shop.
        </s-banner>
      )}
    </s-page>
  );
}
