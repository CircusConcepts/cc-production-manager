import { Prisma, type ItemStatus } from "@prisma/client";
import { format } from "date-fns";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "react-router";

import {
  DEFAULT_LISTS_TABLE_COLUMNS,
  ResizableListsTable,
} from "../components/ResizableListsTable";
import tableStyles from "../components/ResizableListsTable.module.css";
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
import {
  formatDuplicateSerialError,
  formatItemIdentity,
} from "../utils/serializedItem";
import { authenticate } from "../shopify.server";

type ActionResult = { error?: string; success?: string; itemId?: string };

type ItemRow = {
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
};

type RowDraft = {
  productId: string;
  serialNumber: string;
  orderNumber: string;
  status: string;
  colorId: string;
  size: string;
  madeBy: string;
  notes: string;
};

function itemToDraft(item: ItemRow): RowDraft {
  return {
    productId: item.productId,
    serialNumber: item.serialNumber,
    orderNumber: item.orderNumber ?? "",
    status: item.status,
    colorId: item.colorId ?? "",
    size: item.size ?? "",
    madeBy: item.madeBy ?? "",
    notes: item.notes ?? "",
  };
}

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
  let items: ItemRow[] = [];

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

async function findDuplicateSerializedItem(
  shopId: string,
  productId: string,
  serialNumber: string,
  excludeItemId?: string,
) {
  return db.serializedItem.findFirst({
    where: {
      shopId,
      productId,
      serialNumber,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
    },
    include: { product: { select: { sku: true } } },
  });
}

async function saveSerializedItemUpdate({
  shopId,
  categoryId,
  itemId,
  productId,
  serialNumber,
  orderNumber,
  statusInput,
  colorIdRaw,
  size,
  madeBy,
  notes,
}: {
  shopId: string;
  categoryId: string;
  itemId: string;
  productId: string;
  serialNumber: string;
  orderNumber: string;
  statusInput: string;
  colorIdRaw: string;
  size: string;
  madeBy: string;
  notes: string;
}): Promise<ActionResult> {
  if (!productId) return { error: "Product selection is required." };
  if (!serialNumber) return { error: "Serial number is required." };
  if (!isItemStatus(statusInput)) return { error: "Invalid status." };

  const validated = await validateCategoryProduct(shopId, categoryId, productId);
  if ("error" in validated) return { error: validated.error };

  const colorResult = await resolveColorId(shopId, colorIdRaw);
  if ("error" in colorResult) return { error: colorResult.error };

  const item = await db.serializedItem.findFirst({
    where: {
      id: itemId,
      shopId,
      product: { productCategoryId: categoryId },
    },
    include: { product: { select: { sku: true, name: true } } },
  });

  if (!item) return { error: "Item not found." };

  const status = resolveStatusForOrderNumber({
    orderNumber: orderNumber || null,
    requestedStatus: statusInput,
  });

  const duplicate = await findDuplicateSerializedItem(
    shopId,
    validated.product.id,
    serialNumber,
    item.id,
  );

  if (duplicate) {
    return {
      error: formatDuplicateSerialError(validated.product.sku, serialNumber),
      itemId,
    };
  }

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
      shopId,
      action: "serialized_item.updated",
      entity: "SerializedItem",
      entityId: item.id,
      metadata: {
        productId: validated.product.id,
        sku: validated.product.sku,
        productName: validated.product.name,
        serialNumber,
        itemIdentity: formatItemIdentity(validated.product.sku, serialNumber),
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

    if (before.status !== status) {
      await createAuditLog({
        shopId,
        action: "item.status_updated",
        entity: "SerializedItem",
        entityId: item.id,
        metadata: {
          productId: validated.product.id,
          sku: validated.product.sku,
          productName: validated.product.name,
          serialNumber,
          itemIdentity: formatItemIdentity(validated.product.sku, serialNumber),
          categoryId,
          from: before.status,
          to: status,
        },
      });
    }

    return {
      success: `${formatItemIdentity(validated.product.sku, serialNumber)} updated.`,
      itemId,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        error: formatDuplicateSerialError(validated.product.sku, serialNumber),
        itemId,
      };
    }
    throw error;
  }
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

    const duplicate = await findDuplicateSerializedItem(
      shop.id,
      validated.product.id,
      serialNumber,
    );

    if (duplicate) {
      return {
        error: formatDuplicateSerialError(validated.product.sku, serialNumber),
      };
    }

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
          productId: validated.product.id,
          sku: validated.product.sku,
          productName: validated.product.name,
          serialNumber,
          itemIdentity: formatItemIdentity(validated.product.sku, serialNumber),
          categoryId,
          status,
          color: colorResult.colorName,
          size,
          employee: madeBy,
        },
      });

      return {
        success: `${formatItemIdentity(validated.product.sku, serialNumber)} created.`,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: formatDuplicateSerialError(validated.product.sku, serialNumber),
        };
      }
      throw error;
    }
  }

  if (intent === "updateItemInline") {
    return saveSerializedItemUpdate({
      shopId: shop.id,
      categoryId,
      itemId: String(formData.get("itemId") ?? ""),
      productId: String(formData.get("productId") ?? "").trim(),
      serialNumber: String(formData.get("serialNumber") ?? "").trim(),
      orderNumber: String(formData.get("orderNumber") ?? "").trim(),
      statusInput: String(formData.get("status") ?? "IN_STOCK"),
      colorIdRaw: String(formData.get("colorId") ?? ""),
      size: String(formData.get("size") ?? "").trim(),
      madeBy: String(formData.get("madeBy") ?? "").trim(),
      notes: String(formData.get("notes") ?? "").trim(),
    });
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
        productId: item.productId,
        serialNumber: item.serialNumber,
        sku: item.product.sku,
        productName: item.product.name,
        itemIdentity: formatItemIdentity(item.product.sku, item.serialNumber),
        categoryId,
        orderNumber: item.orderNumber,
        color: item.colorRef?.name ?? item.color,
        size: item.size,
        employee: item.madeBy,
        previousStatus: item.status,
      },
    });

    await db.serializedItem.delete({ where: { id: item.id } });

    return {
      success: `Local item ${formatItemIdentity(item.product.sku, item.serialNumber)} deleted.`,
    };
  }

  return { error: "Unknown action." };
};

function matchesItemSearch(item: ItemRow, query: string): boolean {
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

interface InlineListsTableProps {
  items: ItemRow[];
  categoryProducts: Array<{ id: string; sku: string; name: string }>;
  colors: Array<{ id: string; name: string; hex: string | null }>;
  statuses: readonly string[];
  categoryId: string;
}

function InlineListsTable({
  items,
  categoryProducts,
  colors,
  statuses,
  categoryId,
}: InlineListsTableProps) {
  const fetcher = useFetcher<ActionResult>();
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [rowMessages, setRowMessages] = useState<
    Record<string, { error?: string; success?: string }>
  >({});

  const getDraft = useCallback(
    (item: ItemRow): RowDraft => drafts[item.id] ?? itemToDraft(item),
    [drafts],
  );

  const updateDraft = useCallback(
    (item: ItemRow, patch: Partial<RowDraft>) => {
      const current = drafts[item.id] ?? itemToDraft(item);
      const next = { ...current, ...patch };

      if ("orderNumber" in patch && isStockOrderNumber(next.orderNumber)) {
        next.status = "IN_STOCK";
      }

      setDrafts((currentDrafts) => ({ ...currentDrafts, [item.id]: next }));
      setDirtyIds((currentDirty) => new Set(currentDirty).add(item.id));
      setRowMessages((current) => {
        const nextMessages = { ...current };
        delete nextMessages[item.id];
        return nextMessages;
      });
    },
    [drafts],
  );

  const cancelRow = useCallback((item: ItemRow) => {
    setDrafts((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      delete nextDrafts[item.id];
      return nextDrafts;
    });
    setDirtyIds((currentDirty) => {
      const nextDirty = new Set(currentDirty);
      nextDirty.delete(item.id);
      return nextDirty;
    });
    setRowMessages((current) => {
      const nextMessages = { ...current };
      delete nextMessages[item.id];
      return nextMessages;
    });
  }, []);

  const saveRow = useCallback(
    (item: ItemRow) => {
      const draft = getDraft(item);
      fetcher.submit(
        {
          intent: "updateItemInline",
          categoryId,
          itemId: item.id,
          productId: draft.productId,
          serialNumber: draft.serialNumber,
          orderNumber: draft.orderNumber,
          status: draft.status,
          colorId: draft.colorId,
          size: draft.size,
          madeBy: draft.madeBy,
          notes: draft.notes,
        },
        { method: "post" },
      );
    },
    [categoryId, fetcher, getDraft],
  );

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.itemId) return;

    const itemId = fetcher.data.itemId;

    if (fetcher.data.error) {
      setRowMessages((current) => ({
        ...current,
        [itemId]: { error: fetcher.data?.error },
      }));
      return;
    }

    if (fetcher.data.success) {
      setDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[itemId];
        return nextDrafts;
      });
      setDirtyIds((currentDirty) => {
        const nextDirty = new Set(currentDirty);
        nextDirty.delete(itemId);
        return nextDirty;
      });
      setRowMessages((current) => ({
        ...current,
        [itemId]: { success: fetcher.data?.success },
      }));
    }
  }, [fetcher.state, fetcher.data]);

  const tableRows = useMemo(
    () =>
      items.map((item) => {
        const draft = getDraft(item);
        const isDirty = dirtyIds.has(item.id);
        const stockOrder = isStockOrderNumber(draft.orderNumber);
        const saving =
          fetcher.state !== "idle" &&
          fetcher.formData?.get("itemId") === item.id;
        const rowMessage = rowMessages[item.id];

        return {
          id: item.id,
          cells: {
            product: (
              <select
                className={tableStyles.cellSelect}
                value={draft.productId}
                onChange={(event) =>
                  updateDraft(item, { productId: event.currentTarget.value })
                }
              >
                {categoryProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.sku} — {product.name}
                  </option>
                ))}
              </select>
            ),
            serialNumber: (
              <input
                className={tableStyles.cellInput}
                value={draft.serialNumber}
                onChange={(event) =>
                  updateDraft(item, { serialNumber: event.currentTarget.value })
                }
                autoComplete="off"
              />
            ),
            orderNumber: (
              <input
                className={tableStyles.cellInput}
                value={draft.orderNumber}
                onChange={(event) =>
                  updateDraft(item, { orderNumber: event.currentTarget.value })
                }
                autoComplete="off"
              />
            ),
            color: (
              <select
                className={tableStyles.cellSelect}
                value={draft.colorId}
                onChange={(event) =>
                  updateDraft(item, { colorId: event.currentTarget.value })
                }
              >
                <option value="">Select color</option>
                {colors.map((color) => (
                  <option key={color.id} value={color.id}>
                    {color.name}
                  </option>
                ))}
              </select>
            ),
            size: (
              <input
                className={tableStyles.cellInput}
                value={draft.size}
                onChange={(event) =>
                  updateDraft(item, { size: event.currentTarget.value })
                }
                autoComplete="off"
              />
            ),
            employee: (
              <input
                className={tableStyles.cellInput}
                value={draft.madeBy}
                onChange={(event) =>
                  updateDraft(item, { madeBy: event.currentTarget.value })
                }
                autoComplete="off"
              />
            ),
            notes: (
              <textarea
                className={tableStyles.cellTextarea}
                value={draft.notes}
                onChange={(event) =>
                  updateDraft(item, { notes: event.currentTarget.value })
                }
              />
            ),
            updated: format(new Date(item.updatedAt), "MMM d, yyyy HH:mm"),
            updateStatus: stockOrder ? (
              <div>
                <div>In stock</div>
                <div className={tableStyles.rowStatus}>
                  Auto-set because Order # is Stock
                </div>
              </div>
            ) : (
              <select
                className={tableStyles.cellSelect}
                value={draft.status}
                onChange={(event) =>
                  updateDraft(item, { status: event.currentTarget.value })
                }
              >
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {formatStatus(status as ItemStatus)}
                  </option>
                ))}
              </select>
            ),
            rowActions: (
              <div className={tableStyles.rowActions}>
                {isDirty ? (
                  <>
                    <button type="button" onClick={() => saveRow(item)} disabled={saving}>
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button type="button" onClick={() => cancelRow(item)} disabled={saving}>
                      Cancel
                    </button>
                  </>
                ) : rowMessage?.success ? (
                  <span className={tableStyles.rowStatus}>Saved</span>
                ) : null}
                {rowMessage?.error && (
                  <span className={tableStyles.rowError}>{rowMessage.error}</span>
                )}
              </div>
            ),
            delete: (
              <Form
                method="post"
                onSubmit={(event) => {
                  if (
                    !confirm(
                      "Delete this local item from the app database? This does not affect Shopify.",
                    )
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="intent" value="deleteItem" />
                <input type="hidden" name="categoryId" value={categoryId} />
                <input type="hidden" name="itemId" value={item.id} />
                <s-button type="submit" variant="secondary">
                  Delete item
                </s-button>
              </Form>
            ),
          },
        };
      }),
    [
      items,
      getDraft,
      dirtyIds,
      categoryProducts,
      colors,
      statuses,
      categoryId,
      updateDraft,
      saveRow,
      cancelRow,
      fetcher.state,
      fetcher.formData,
      rowMessages,
    ],
  );

  return (
    <div className="appTableArea">
      <ResizableListsTable
        storageKey={`lists-table-columns:${categoryId}`}
        columns={DEFAULT_LISTS_TABLE_COLUMNS}
        rows={tableRows}
      />
    </div>
  );
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
  const [createOrderNumber, setCreateOrderNumber] = useState("");
  const [createStatus, setCreateStatus] = useState("IN_STOCK");
  const createIsStock = isStockOrderNumber(createOrderNumber);

  const filteredItems = useMemo(() => {
    const safeItems = Array.isArray(items) ? items : [];
    const q = itemSearch.trim();
    if (!q) return safeItems;
    return safeItems.filter((item) => matchesItemSearch(item, q));
  }, [items, itemSearch]);

  return (
    <s-page heading="Lists">
      <div className="appWideSection">
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
              onChange={(event) => {
                const nextCategoryId = event.currentTarget.value;
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
                      onInput={(event) => setCreateOrderNumber(event.currentTarget.value)}
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
                      onChange={(event) => setCreateStatus(event.currentTarget.value)}
                    >
                      {statuses.map((status) => (
                        <s-option key={status} value={status}>
                          {formatStatus(status as ItemStatus)}
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
                onInput={(event) => setItemSearch(event.currentTarget.value)}
                autocomplete="off"
              />

              {filteredItems.length === 0 ? (
                <s-text>No list items for this category yet.</s-text>
              ) : (
                <InlineListsTable
                  items={filteredItems}
                  categoryProducts={categoryProducts}
                  colors={colors}
                  statuses={statuses}
                  categoryId={selectedCategory.id}
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
      </div>
    </s-page>
  );
}
