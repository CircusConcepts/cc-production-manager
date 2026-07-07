#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function normalizeSku(value) {
  return String(value ?? "").trim().toUpperCase();
}

function pickCanonicalProduct(products, normalizedSku) {
  const exactMatch = products.find((product) => product.sku === normalizedSku);
  if (exactMatch) return exactMatch;

  return [...products].sort((a, b) => {
    const createdAtDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  })[0];
}

function mergeProductFields(canonical, duplicates) {
  let name = canonical.name;
  let category = canonical.category;
  let notes = canonical.notes;
  let active = canonical.active;

  for (const duplicate of duplicates) {
    if (!name?.trim() && duplicate.name?.trim()) {
      name = duplicate.name;
    }
    if (!category?.trim() && duplicate.category?.trim()) {
      category = duplicate.category;
    }
    if (!notes?.trim() && duplicate.notes?.trim()) {
      notes = duplicate.notes;
    }
    if (duplicate.active) {
      active = true;
    }
  }

  return { name, category, notes, active };
}

function printUsage() {
  console.log(`Usage:
  node scripts/merge-duplicate-skus.mjs <shop-domain> DRY_RUN
  node scripts/merge-duplicate-skus.mjs <shop-domain> CONFIRM_MERGE_DUPLICATE_SKUS

Examples:
  node --env-file=.env scripts/merge-duplicate-skus.mjs circusconcepts.myshopify.com DRY_RUN
  node --env-file=.env scripts/merge-duplicate-skus.mjs circusconcepts.myshopify.com CONFIRM_MERGE_DUPLICATE_SKUS

If no shop domain is provided, available shops are listed.`);
}

async function listShops() {
  const shops = await prisma.shop.findMany({
    orderBy: { shop: "asc" },
    select: { shop: true, name: true },
  });

  if (shops.length === 0) {
    console.log("No shops found in the database.");
    return;
  }

  console.log("Available shops:");
  for (const shop of shops) {
    const label = shop.name ? `${shop.shop} (${shop.name})` : shop.shop;
    console.log(`- ${label}`);
  }
}

async function mergeDuplicateSkusForShop(shopDomain, dryRun) {
  const shop = await prisma.shop.findUnique({
    where: { shop: shopDomain },
  });

  if (!shop) {
    throw new Error(`Shop not found: ${shopDomain}`);
  }

  const products = await prisma.product.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "asc" },
  });

  const groups = new Map();

  for (const product of products) {
    const normalizedSku = normalizeSku(product.sku);
    if (!normalizedSku) continue;

    if (!groups.has(normalizedSku)) {
      groups.set(normalizedSku, []);
    }
    groups.get(normalizedSku).push(product);
  }

  const duplicateGroups = [...groups.entries()].filter(
    ([, group]) => group.length > 1,
  );

  const singleCaseFixes = [...groups.entries()].filter(
    ([normalizedSku, group]) =>
      group.length === 1 && group[0].sku !== normalizedSku,
  );

  console.log(`Shop: ${shop.shop}`);
  console.log(`Products: ${products.length}`);
  console.log(`Duplicate SKU groups: ${duplicateGroups.length}`);
  console.log(`Single-product SKU case fixes: ${singleCaseFixes.length}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE MERGE"}`);
  console.log("");

  if (duplicateGroups.length === 0 && singleCaseFixes.length === 0) {
    console.log("Nothing to merge or normalize.");
    return;
  }

  let totalMovedItems = 0;
  let totalDeletedProducts = 0;

  for (const [normalizedSku, group] of duplicateGroups) {
    const canonical = pickCanonicalProduct(group, normalizedSku);
    const duplicates = group.filter((product) => product.id !== canonical.id);
    const duplicateProductIds = duplicates.map((product) => product.id);
    const duplicateSkuValues = duplicates.map((product) => product.sku);

    const itemCounts = await Promise.all(
      group.map(async (product) => ({
        productId: product.id,
        sku: product.sku,
        count: await prisma.serializedItem.count({
          where: { shopId: shop.id, productId: product.id },
        }),
      })),
    );

    const movedItemCount = itemCounts
      .filter((entry) => entry.productId !== canonical.id)
      .reduce((sum, entry) => sum + entry.count, 0);

    console.log(`SKU group: ${normalizedSku}`);
    console.log(`  Canonical product: ${canonical.id} (${canonical.sku})`);
    console.log(`  Duplicate product IDs: ${duplicateProductIds.join(", ") || "none"}`);
    console.log(`  Duplicate SKU values: ${duplicateSkuValues.join(", ") || "none"}`);
    console.log(`  Items to move: ${movedItemCount}`);
    for (const entry of itemCounts) {
      console.log(`    ${entry.sku}: ${entry.count} item(s)`);
    }

    if (dryRun) {
      totalMovedItems += movedItemCount;
      totalDeletedProducts += duplicates.length;
      console.log("");
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          shopId: shop.id,
          action: "product.sku_duplicates_merge_started",
          entity: "Product",
          entityId: canonical.id,
          metadata: {
            shopId: shop.id,
            normalizedSku,
            canonicalProductId: canonical.id,
            duplicateProductIds,
            duplicateSkuValues,
            movedItemCount,
          },
        },
      });

      if (movedItemCount > 0) {
        const reassigned = await tx.serializedItem.updateMany({
          where: {
            shopId: shop.id,
            productId: { in: duplicateProductIds },
          },
          data: { productId: canonical.id },
        });

        await tx.auditLog.create({
          data: {
            shopId: shop.id,
            action: "serialized_items.reassigned_for_sku_merge",
            entity: "Product",
            entityId: canonical.id,
            metadata: {
              shopId: shop.id,
              normalizedSku,
              canonicalProductId: canonical.id,
              duplicateProductIds,
              duplicateSkuValues,
              movedItemCount: reassigned.count,
            },
          },
        });
      }

      const mergedFields = mergeProductFields(canonical, duplicates);

      await tx.product.update({
        where: { id: canonical.id },
        data: {
          sku: normalizedSku,
          name: mergedFields.name,
          category: mergedFields.category,
          notes: mergedFields.notes,
          active: mergedFields.active,
        },
      });

      for (const duplicate of duplicates) {
        await tx.auditLog.create({
          data: {
            shopId: shop.id,
            action: "product.duplicate_deleted_after_sku_merge",
            entity: "Product",
            entityId: duplicate.id,
            metadata: {
              shopId: shop.id,
              normalizedSku,
              canonicalProductId: canonical.id,
              duplicateProductId: duplicate.id,
              duplicateSku: duplicate.sku,
            },
          },
        });

        await tx.product.delete({ where: { id: duplicate.id } });
      }

      await tx.auditLog.create({
        data: {
          shopId: shop.id,
          action: "product.sku_duplicates_merge_completed",
          entity: "Product",
          entityId: canonical.id,
          metadata: {
            shopId: shop.id,
            normalizedSku,
            canonicalProductId: canonical.id,
            duplicateProductIds,
            duplicateSkuValues,
            movedItemCount,
            deletedProductCount: duplicates.length,
          },
        },
      });
    });

    totalMovedItems += movedItemCount;
    totalDeletedProducts += duplicates.length;
    console.log("  Merged.");
    console.log("");
  }

  for (const [normalizedSku, group] of singleCaseFixes) {
    const product = group[0];
    console.log(`Normalize single SKU: ${product.sku} -> ${normalizedSku}`);

    if (dryRun) {
      console.log("");
      continue;
    }

    await prisma.product.update({
      where: { id: product.id },
      data: { sku: normalizedSku },
    });

    console.log("  Updated.");
    console.log("");
  }

  console.log("Summary:");
  console.log(`  Duplicate groups processed: ${duplicateGroups.length}`);
  console.log(`  Items moved: ${totalMovedItems}`);
  console.log(`  Duplicate products deleted: ${totalDeletedProducts}`);
  console.log(`  Single-product SKU normalizations: ${singleCaseFixes.length}`);
}

async function main() {
  const shopDomain = process.argv[2];
  const mode = process.argv[3];

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }

  if (!shopDomain || !mode) {
    printUsage();
    await listShops();
    process.exit(shopDomain ? 1 : 0);
  }

  if (mode !== "DRY_RUN" && mode !== "CONFIRM_MERGE_DUPLICATE_SKUS") {
    console.error(
      'Mode must be "DRY_RUN" or "CONFIRM_MERGE_DUPLICATE_SKUS".',
    );
    printUsage();
    process.exit(1);
  }

  try {
    await mergeDuplicateSkusForShop(
      shopDomain,
      mode === "DRY_RUN",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
