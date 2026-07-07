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

import {
  DEFAULT_LISTS_TABLE_COLUMNS,
  ResizableListsTable,
} from "../components/ResizableListsTable";
import db from "../db.server";
import { createAuditLog } from "../services/audit.server";
import { findColorForShop } from "../services/color.server";
import { findProductCategoryForShop } from "../services/productCategory.server";
import { getOrCreateShop } from "../services/shop.server";
import { ITEM_STATUSES, isItemStatus } from "../utils/itemConstants";
import { formatStatus } from "../utils/labels";
import {
  isStockOrderNumber,
  resolveStatusForOrderNumber,
} from "../utils/itemStatus";
import { authenticate } from "../shopify.server";

type ActionResult = { error?: string; success?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const url = new URL(request.url);
  const categoryId = url.searchParams.get("categoryId");

  const [categories, colors] = await Promise.all([
    db.productCategory.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { products: true } },
        products: {
          select: {
            id: true,
            _count: { select: { items: true } },
            items: {
              where: { status: "IN_STOCK" },
              select: { id: true },
            },
          },
        },
      },
    }),
    db.color.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, hex: true },
    }),
  ]);

  const categoryOptions = categories.map((category) => {
    const itemCount = category.products.reduce(
      (sum, product) => sum + product._count.items,
      0,
    );
    const inStockCount = category.products.reduce(
      (sum, product) => sum + product.items.length,
      0,
    );

    return {
      id: category.id,
      name: category.name,
      productCount: category._count.products,
      itemCount,
      inStockCount,
    };
  });

  let selectedCategory: {
    id: string;
    name: string;
    productCount: number;
    itemCount: number;
    inStockCount: number;
  } | null = null;

  let categoryProducts: Array<{ id: string; sku: string; name: string }> = [];
  let items: Array<{
    id: string;
    productId: string;
    sku: string;
    productName: string;
    serialNumber: string;
    status: string;
    orderNumber: string | null;
    colorId: string | null;
    colorName: string | null;
    size: string | null;
    madeBy: string | null;
    notes: string | null;
    updatedAt: string;
  }> = [];

  if (categoryId) {
    const category = await db.productCategory.findFirst({
      where: { id: categoryId, shopId: shop.id },
      include: {
        _count: { select: { products: true } },
        products: {
          where: { active: true },
          orderBy: { sku: "asc" },
          select: {
            id: true,
            sku: true,
            name: true,
            _count: { select: { items: true } },
            items: {
              where: { status: "IN_STOCK" },
              select: { id: true },
            },
          },
        },
      },
    });

    if (category) {
      const itemCount = category.products.reduce(
        (sum, product) => sum + product._count.items,
        0,
      );
      const inStockCount = category.products.reduce(
        (sum, product) => sum + product.items.length,
        0,
      );

      selectedCategory = {
        id: category.id,
        name: category.name,
        productCount: category._count.products,
        itemCount,
        inStockCount,
      };

      categoryProducts = category.products.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
      }));

      const rows = await db.serializedItem.findMany({
        where: {
          shopId: shop.id,
          product: { productCategoryId: category.id },
        },
        orderBy: [{ product: { sku: "asc" } }, { updatedAt: "desc" }],
        include: {
          product: { select: { id: true, sku: true, name: true } },
          colorRef: { select: { name: true } },
        },
      });

      items = rows.map((item) => ({
        id: item.id,
        productId: item.productId,
        sku: item.product.sku,
        productName: item.product.name,
        serialNumber: item.serialNumber,
        status: item.status,
        orderNumber: item.orderNumber,
        colorId: item.colorId,
        colorName: item.colorRef?.name ?? item.color,
        size: item.size,
        madeBy: item.madeBy,
        notes: item.notes,
        updatedAt: item.updatedAt.toISOString(),
      }));
    }
  }

  return {
    categoryOptions,
    selectedCategory,
    categoryProducts,
    items,
    colors,
    statuses: ITEM_STATUSES,
  };
};

async function validateCategoryProduct(
  shopId: string,
  categoryId: string,
  productId: string,
) {
  const category = await findProductCategoryForShop(shopId, categoryId);
  if (!category) {
    return { error: "Product category not found." as const };
  }

  const product = await db.product.findFirst({
    where: {
      id: productId,
      shopId,
      productCategoryId: categoryId,
    },
    select: { id: true, sku: true, name: true },
  });

  if (!product) {
    return { error: "Selected product does not belong to this category." as const };
  }

  return { category, product };
}

async function resolveColorId(
  shopId: string,
  colorIdRaw: string,
): Promise<{ colorId: string | null; colorName: string | null } | { error: string }> {
  const colorId = colorIdRaw.trim();
  if (!colorId) {
    return { colorId: null, colorName: null };
  }

  const color = await findColorForShop(shopId, colorId);
  if (!color) {
    return { error: "Invalid color." };
  }

  return { colorId: color.id, colorName: color.name };
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const categoryId = String(formData.get("categoryId") ?? "").trim();

  if (!categoryId) {
    return { error: "Product category selection is required." };
  }

  if (intent === "create") {
    const productId = String(formData.get("productId") ?? "").trim();
    const serialNumber = String(formData.get("serialNumber") ?? "").trim();
    const statusInput = String(formData.get("status") ?? "IN_STOCK");
    const orderNumber = String(formData.get("orderNumber") ?? "").trim();
    const size = String(formData.get("size") ?? "").trim();
    const madeBy = String(formData.get("madeBy") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const colorIdRaw = String(formData.get("colorId") ?? "");

    if (!productId) return { error: "Product selection is required." };
    if (!serialNumber) return { error: "Serial number is required." };
    if (!isItemStatus(statusInput)) return { error: "Invalid status." };

    const validated = await validateCategoryProduct(shop.id, categoryId, productId);
    if ("error" in validated) return { error: validated.error };

    const colorResult = await resolveColorId(shop.id, colorIdRaw);
    if ("error" in colorResult) return { error: colorResult.error };

    const status = resolveStatusForOrderNumber({
      orderNumber: orderNumber || null,
      requestedStatus: statusInput,
    });

    try {
      const item = await db.serializedItem.create({
        data: {
          shopId: shop.id,
          productId: validated.product.id,
          serialNumber,
          status,
          sourceType: "MANUAL",
          orderNumber: orderNumber || null,
          colorId: colorResult.colorId,
          color: colorResult.colorName,
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
          sku: validated.product.sku,
          categoryId,
          status,
          color: colorResult.colorName,
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
      where: {
        id: itemId,
        shopId: shop.id,
        product: { productCategoryId: categoryId },
      },
      include: { product: { select: { sku: true, name: true } } },
    });

    if (!item) return { error: "Item not found." };

    const status = resolveStatusForOrderNumber({
      orderNumber: item.orderNumber,
      requestedStatus: statusInput,
    });

    if (item.status === status) {
      return {
        success: `Item "${item.serialNumber}" is already ${formatStatus(status)}.`,
      };
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
        categoryId,
        from: previousStatus,
        to: status,
      },
    });

    return {
      success: `Item "${item.serialNumber}" updated to ${formatStatus(status)}.`,
    };
  }

  if (intent === "updateItem") {
    const itemId = String(formData.get("itemId") ?? "");
    const productId = String(formData.get("productId") ?? "").trim();
    const serialNumber = String(formData.get("serialNumber") ?? "").trim();
    const statusInput = String(formData.get("status") ?? "IN_STOCK");
    const orderNumber = String(formData.get("orderNumber") ?? "").trim();
    const size = String(formData.get("size") ?? "").trim();
    const madeBy = String(formData.get("madeBy") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const colorIdRaw = String(formData.get("colorId") ?? "");

    if (!productId) return { error: "Product selection is required." };
    if (!serialNumber) return { error: "Serial number is required." };
    if (!isItemStatus(statusInput)) return { error: "Invalid status." };

    const validated = await validateCategoryProduct(shop.id, categoryId, productId);
    if ("error" in validated) return { error: validated.error };

    const colorResult = await resolveColorId(shop.id, colorIdRaw);
    if ("error" in colorResult) return { error: colorResult.error };

    const item = await db.serializedItem.findFirst({
      where: {
        id: itemId,
        shopId: shop.id,
        product: { productCategoryId: categoryId },
      },
      include: { product: { select: { sku: true, name: true } } },
    });

    if (!item) return { error: "Item not found." };

    const status = resolveStatusForOrderNumber({
      orderNumber: orderNumber || null,
      requestedStatus: statusInput,
    });

    const before = {
      productId: item.productId,
      serialNumber: item.serialNumber,
      status: item.status,
      orderNumber: item.orderNumber,
      colorId: item.colorId,
      size: item.size,
      madeBy: item.madeBy,
      notes: item.notes,
    };

    try {
      await db.serializedItem.update({
        where: { id: item.id },
        data: {
          productId: validated.product.id,
          serialNumber,
          status,
          orderNumber: orderNumber || null,
          colorId: colorResult.colorId,
          color: colorResult.colorName,
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
          sku: validated.product.sku,
          categoryId,
          before,
          after: {
            productId: validated.product.id,
            serialNumber,
            status,
            orderNumber: orderNumber || null,
            colorId: colorResult.colorId,
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
      where: {
        id: itemId,
        shopId: shop.id,
        product: { productCategoryId: categoryId },
      },
      include: {
        product: { select: { sku: true, name: true } },
        colorRef: { select: { name: true } },
      },
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
        categoryId,
        orderNumber: item.orderNumber,
        color: item.colorRef?.name ?? item.color,
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
    sku: string;
    productName: string;
    serialNumber: string;
    orderNumber: string | null;
    status: string;
    colorName: string | null;
    size: string | null;
    madeBy: string | null;
    notes: string | null;
  },
  query: string,
): boolean {
  const q = query.toLowerCase();
  const haystack = [
    item.sku,
    item.productName,
    item.serialNumber,
    item.orderNumber,
    formatStatus(item.status as never),
    item.colorName,
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
  const loaderData = useLoaderData<typeof loader>();
  const categoryOptions = loaderData?.categoryOptions ?? [];
  const selectedCategory = loaderData?.selectedCategory ?? null;
  const categoryProducts = loaderData?.categoryProducts ?? [];
  const items = loaderData?.items ?? [];
  const colors = loaderData?.colors ?? [];
  const statuses = loaderData?.statuses ?? ITEM_STATUSES;
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const categoryId = searchParams.get("categoryId") ?? "";

  const [itemSearch, setItemSearch] = useState("");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState("IN_STOCK");
  const [createOrderNumber, setCreateOrderNumber] = useState("");
  const [createStatus, setCreateStatus] = useState("IN_STOCK");
  const createIsStock = isStockOrderNumber(createOrderNumber);

  const filteredItems = useMemo(() => {
    const safeItems = Array.isArray(items) ? items : [];
    const q = itemSearch.trim();
    if (!q) return safeItems;
    return safeItems.filter((item) => matchesItemSearch(item, q));
  }, [items, itemSearch]);

  const tableRows = useMemo(
    () =>
      (Array.isArray(filteredItems) ? filteredItems : []).map((item) => {
        const stockOrder = isStockOrderNumber(item.orderNumber);

        return {
          id: item.id,
          cells: {
            sku: item.sku,
            productName: item.productName,
            serialNumber: item.serialNumber,
            orderNumber: item.orderNumber ?? "—",
            color: item.colorName ?? "—",
            size: item.size ?? "—",
            employee: item.madeBy ?? "—",
            notes: item.notes ?? "—",
            updated: format(new Date(item.updatedAt), "MMM d, yyyy HH:mm"),
            updateStatus: stockOrder ? (
              <div>
                <div>In stock</div>
                <div>Auto-set because Order # is Stock</div>
              </div>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="updateStatus" />
                <input type="hidden" name="categoryId" value={selectedCategory?.id} />
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
            ),
            edit: (
              <s-button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditingItemId(item.id);
                  setEditStatus(item.status);
                }}
              >
                Edit
              </s-button>
            ),
            delete: (
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
                <input type="hidden" name="categoryId" value={selectedCategory?.id} />
                <input type="hidden" name="itemId" value={item.id} />
                <s-button type="submit" variant="secondary">
                  Delete item
                </s-button>
              </Form>
            ),
          },
        };
      }),
    [filteredItems, selectedCategory?.id, statuses],
  );

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

      <s-section heading="Select product category">
        <s-text>
          Choose a product category to view and manage all list items for its
          products. All changes are saved only in this app database — never in
          Shopify.
        </s-text>

        {categoryOptions.length === 0 ? (
          <s-text>
            Create product categories on the Products page, assign products to
            them, then return here.
          </s-text>
        ) : (
          <s-select
            label="Product category"
            value={categoryId}
            onChange={(e) => {
              const nextCategoryId = e.currentTarget.value;
              navigate(
                nextCategoryId
                  ? `/app/items?categoryId=${nextCategoryId}`
                  : "/app/items",
              );
            }}
          >
            <s-option value="">Select product category</s-option>
            {categoryOptions.map((category) => (
              <s-option key={category.id} value={category.id}>
                {category.name} ({category.productCount} products,{" "}
                {category.itemCount} items)
              </s-option>
            ))}
          </s-select>
        )}
      </s-section>

      {selectedCategory && (
        <>
          <s-section heading={`Lists for ${selectedCategory.name}`}>
            <s-stack direction="block" gap="base">
              <s-text>Category: {selectedCategory.name}</s-text>
              <s-text>Products/SKUs: {selectedCategory.productCount}</s-text>
              <s-text>Total list items: {selectedCategory.itemCount}</s-text>
              <s-text>In stock: {selectedCategory.inStockCount}</s-text>
            </s-stack>
          </s-section>

          <s-section heading={`Add item — ${selectedCategory.name}`}>
            {categoryProducts.length === 0 ? (
              <s-text>Add products to this category first.</s-text>
            ) : colors.length === 0 ? (
              <s-text>Define colors first on the Products page.</s-text>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="create" />
                <input type="hidden" name="categoryId" value={selectedCategory.id} />
                <s-stack direction="block" gap="base">
                  <s-select name="productId" label="Product" value="">
                    <s-option value="">Select product</s-option>
                    {categoryProducts.map((product) => (
                      <s-option key={product.id} value={product.id}>
                        {product.sku} — {product.name}
                      </s-option>
                    ))}
                  </s-select>
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
                  <s-select name="colorId" label="Color" value="">
                    <s-option value="">Select color</s-option>
                    {colors.map((color) => (
                      <s-option key={color.id} value={color.id}>
                        {color.name}
                      </s-option>
                    ))}
                  </s-select>
                  <s-text-field name="size" label="Size" autocomplete="off" />
                  <s-text-field name="madeBy" label="Employee" autocomplete="off" />
                  <s-text-area name="notes" label="Notes" />
                  <s-button type="submit" variant="primary">
                    Add item
                  </s-button>
                </s-stack>
              </Form>
            )}
          </s-section>

          <s-section heading={`Items (${filteredItems.length})`}>
            <s-text-field
              label="Search items"
              value={itemSearch}
              onInput={(e) => setItemSearch(e.currentTarget.value)}
              autocomplete="off"
            />

            {editingItemId && (() => {
              const editingItem = items.find((item) => item.id === editingItemId);
              if (!editingItem || !selectedCategory) return null;
              const editStockOrder = isStockOrderNumber(editingItem.orderNumber);

              return (
                <s-section heading={`Edit item ${editingItem.serialNumber}`}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="updateItem" />
                    <input type="hidden" name="categoryId" value={selectedCategory.id} />
                    <input type="hidden" name="itemId" value={editingItem.id} />
                    <s-stack direction="block" gap="base">
                      <s-select
                        name="productId"
                        label="Product"
                        value={editingItem.productId}
                      >
                        {categoryProducts.map((product) => (
                          <s-option key={product.id} value={product.id}>
                            {product.sku} — {product.name}
                          </s-option>
                        ))}
                      </s-select>
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
                        name="colorId"
                        label="Color"
                        value={editingItem.colorId ?? ""}
                      >
                        <s-option value="">Select color</s-option>
                        {colors.map((color) => (
                          <s-option key={color.id} value={color.id}>
                            {color.name}
                          </s-option>
                        ))}
                      </s-select>
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
              <s-text>No list items for this category yet.</s-text>
            ) : (
              <ResizableListsTable
                storageKey={`lists-table-columns:${selectedCategory.id}`}
                columns={DEFAULT_LISTS_TABLE_COLUMNS}
                rows={tableRows}
              />
            )}
          </s-section>
        </>
      )}

      {!selectedCategory && categoryId && (
        <s-banner tone="warning" heading="Product category not found">
          The selected product category was not found for this shop.
        </s-banner>
      )}
    </s-page>
  );
}
