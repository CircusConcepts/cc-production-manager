import db from "../db.server";
import { createAuditLog } from "./audit.server";

export function normalizeCategoryName(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export async function ensureProductCategoryByName(
  shopId: string,
  rawName: string,
): Promise<{ id: string; name: string } | null> {
  const name = normalizeCategoryName(rawName);
  if (!name) return null;

  const existing = await db.productCategory.findFirst({
    where: {
      shopId,
      name: { equals: name, mode: "insensitive" },
    },
  });

  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  const category = await db.productCategory.create({
    data: { shopId, name, active: true },
  });

  await createAuditLog({
    shopId,
    action: "product_category.created",
    entity: "ProductCategory",
    entityId: category.id,
    metadata: { name: category.name, source: "import_or_auto" },
  });

  return { id: category.id, name: category.name };
}

export async function findProductCategoryForShop(
  shopId: string,
  categoryId: string,
) {
  return db.productCategory.findFirst({
    where: { id: categoryId, shopId },
  });
}

export async function assignProductToCategory({
  shopId,
  productId,
  categoryId,
  previousCategoryId,
}: {
  shopId: string;
  productId: string;
  categoryId: string | null;
  previousCategoryId?: string | null;
}) {
  if (categoryId) {
    const category = await findProductCategoryForShop(shopId, categoryId);
    if (!category) {
      throw new Error("Product category not found.");
    }
  }

  const product = await db.product.update({
    where: { id: productId },
    data: {
      productCategoryId: categoryId,
      category: categoryId
        ? (
            await db.productCategory.findUnique({
              where: { id: categoryId },
              select: { name: true },
            })
          )?.name ?? null
        : null,
    },
  });

  if (previousCategoryId && previousCategoryId !== categoryId) {
    await createAuditLog({
      shopId,
      action: "product.removed_from_category",
      entity: "Product",
      entityId: productId,
      metadata: {
        sku: product.sku,
        previousCategoryId,
      },
    });
  }

  if (categoryId && previousCategoryId !== categoryId) {
    await createAuditLog({
      shopId,
      action: "product.assigned_to_category",
      entity: "Product",
      entityId: productId,
      metadata: {
        sku: product.sku,
        categoryId,
      },
    });
  }

  return product;
}
