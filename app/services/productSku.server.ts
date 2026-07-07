import db from "../db.server";
import { createAuditLog } from "./audit.server";
import { ensureProductCategoryByName } from "./productCategory.server";
import { normalizeSku, pickCanonicalProduct } from "../utils/sku";

export async function findConflictingProduct(
  shopId: string,
  rawSku: string,
  excludeProductId?: string,
) {
  const normalizedSku = normalizeSku(rawSku);
  if (!normalizedSku) return null;

  return db.product.findFirst({
    where: {
      shopId,
      sku: { equals: normalizedSku, mode: "insensitive" },
      ...(excludeProductId ? { NOT: { id: excludeProductId } } : {}),
    },
  });
}

export async function ensureProductForSku(
  shopId: string,
  rawSku: string,
  productName?: string,
  categoryName?: string,
): Promise<{ id: string; created: boolean; sku: string }> {
  const normalizedSku = normalizeSku(rawSku);
  if (!normalizedSku) {
    throw new Error("SKU is required.");
  }

  const matches = await db.product.findMany({
    where: {
      shopId,
      sku: { equals: normalizedSku, mode: "insensitive" },
    },
    orderBy: { createdAt: "asc" },
  });

  if (matches.length > 0) {
    const product = pickCanonicalProduct(matches, normalizedSku);
    const updates: {
      sku?: string;
      name?: string;
    } = {};

    if (matches.length === 1 && product.sku !== normalizedSku) {
      updates.sku = normalizedSku;
    }

    const shouldUpdateName =
      productName &&
      productName !== normalizedSku &&
      (!product.name || product.name === product.sku);

    if (shouldUpdateName) {
      updates.name = productName;
    }

    if (Object.keys(updates).length > 0) {
      await db.product.update({
        where: { id: product.id },
        data: updates,
      });
    }

    await assignCategoryToProduct(shopId, product.id, categoryName);

    return { id: product.id, created: false, sku: normalizedSku };
  }

  const product = await db.product.create({
    data: {
      shopId,
      sku: normalizedSku,
      name: productName || normalizedSku,
      active: true,
    },
  });

  await createAuditLog({
    shopId,
    action: "PRODUCT_CREATED_FROM_IMPORT",
    entity: "Product",
    entityId: product.id,
    metadata: { sku: normalizedSku, name: product.name },
  });

  await assignCategoryToProduct(shopId, product.id, categoryName);

  return { id: product.id, created: true, sku: normalizedSku };
}

async function assignCategoryToProduct(
  shopId: string,
  productId: string,
  categoryName?: string,
) {
  if (!categoryName?.trim()) return;

  const category = await ensureProductCategoryByName(shopId, categoryName);
  if (!category) return;

  await db.product.update({
    where: { id: productId },
    data: {
      productCategoryId: category.id,
      category: category.name,
    },
  });

  await createAuditLog({
    shopId,
    action: "product.assigned_to_category",
    entity: "Product",
    entityId: productId,
    metadata: {
      categoryId: category.id,
      categoryName: category.name,
      source: "import",
    },
  });
}
