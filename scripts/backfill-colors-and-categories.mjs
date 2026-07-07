#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function normalizeName(value) {
  return String(value ?? "").trim();
}

function printUsage() {
  console.log(`Usage:
  node scripts/backfill-colors-and-categories.mjs <shop-domain> DRY_RUN
  node scripts/backfill-colors-and-categories.mjs <shop-domain> CONFIRM_BACKFILL

Example:
  node --env-file=.env scripts/backfill-colors-and-categories.mjs circusconcepts.myshopify.com DRY_RUN`);
}

async function listShops() {
  const shops = await prisma.shop.findMany({
    orderBy: { shop: "asc" },
    select: { shop: true, name: true },
  });

  if (shops.length === 0) {
    console.log("No shops found.");
    return;
  }

  console.log("Available shops:");
  for (const shop of shops) {
    console.log(`- ${shop.shop}${shop.name ? ` (${shop.name})` : ""}`);
  }
}

async function backfillShop(shopDomain, dryRun) {
  const shop = await prisma.shop.findUnique({ where: { shop: shopDomain } });
  if (!shop) {
    throw new Error(`Shop not found: ${shopDomain}`);
  }

  const products = await prisma.product.findMany({
    where: { shopId: shop.id },
    select: { id: true, category: true, productCategoryId: true, sku: true },
  });

  const items = await prisma.serializedItem.findMany({
    where: { shopId: shop.id },
    select: { id: true, color: true, colorId: true, serialNumber: true },
  });

  const categoryNames = [
    ...new Set(
      products
        .map((product) => normalizeName(product.category))
        .filter(Boolean),
    ),
  ];

  const colorNames = [
    ...new Set(
      items.map((item) => normalizeName(item.color)).filter(Boolean),
    ),
  ];

  const productsNeedingCategory = products.filter(
    (product) => !product.productCategoryId && normalizeName(product.category),
  );

  const itemsNeedingColor = items.filter(
    (item) => !item.colorId && normalizeName(item.color),
  );

  console.log(`Shop: ${shop.shop}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE BACKFILL"}`);
  console.log(`Distinct legacy categories: ${categoryNames.length}`);
  console.log(`Products needing category link: ${productsNeedingCategory.length}`);
  console.log(`Distinct legacy colors: ${colorNames.length}`);
  console.log(`Items needing color link: ${itemsNeedingColor.length}`);

  if (dryRun) {
    for (const name of categoryNames) {
      console.log(`Would ensure ProductCategory: ${name}`);
    }
    for (const product of productsNeedingCategory) {
      console.log(
        `Would link product ${product.sku} to category "${normalizeName(product.category)}"`,
      );
    }
    for (const name of colorNames) {
      console.log(`Would ensure Color: ${name}`);
    }
    for (const item of itemsNeedingColor.slice(0, 20)) {
      console.log(
        `Would link item ${item.serialNumber} to color "${normalizeName(item.color)}"`,
      );
    }
    if (itemsNeedingColor.length > 20) {
      console.log(`... and ${itemsNeedingColor.length - 20} more items`);
    }
    return;
  }

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "product_categories.backfill_started",
      entity: "Shop",
      entityId: shop.id,
      metadata: {
        categoryCount: categoryNames.length,
        productsNeedingCategory: productsNeedingCategory.length,
      },
    },
  });

  const categoryMap = new Map();

  for (const name of categoryNames) {
    const existing = await prisma.productCategory.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
      },
    });

    const category =
      existing ??
      (await prisma.productCategory.create({
        data: { shopId: shop.id, name, active: true },
      }));

    categoryMap.set(name.toLowerCase(), category);
  }

  for (const product of productsNeedingCategory) {
    const name = normalizeName(product.category);
    const category = categoryMap.get(name.toLowerCase());
    if (!category) continue;

    await prisma.product.update({
      where: { id: product.id },
      data: {
        productCategoryId: category.id,
        category: category.name,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "product_categories.backfill_completed",
      entity: "Shop",
      entityId: shop.id,
      metadata: {
        categoriesCreatedOrLinked: categoryMap.size,
        productsUpdated: productsNeedingCategory.length,
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "colors.backfill_started",
      entity: "Shop",
      entityId: shop.id,
      metadata: {
        colorCount: colorNames.length,
        itemsNeedingColor: itemsNeedingColor.length,
      },
    },
  });

  const colorMap = new Map();

  for (const name of colorNames) {
    const existing = await prisma.color.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
      },
    });

    const color =
      existing ??
      (await prisma.color.create({
        data: { shopId: shop.id, name, active: true },
      }));

    colorMap.set(name.toLowerCase(), color);
  }

  for (const item of itemsNeedingColor) {
    const name = normalizeName(item.color);
    const color = colorMap.get(name.toLowerCase());
    if (!color) continue;

    await prisma.serializedItem.update({
      where: { id: item.id },
      data: {
        colorId: color.id,
        color: color.name,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      shopId: shop.id,
      action: "colors.backfill_completed",
      entity: "Shop",
      entityId: shop.id,
      metadata: {
        colorsCreatedOrLinked: colorMap.size,
        itemsUpdated: itemsNeedingColor.length,
      },
    },
  });

  console.log("Backfill completed.");
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

  if (mode !== "DRY_RUN" && mode !== "CONFIRM_BACKFILL") {
    console.error('Mode must be "DRY_RUN" or "CONFIRM_BACKFILL".');
    process.exit(1);
  }

  try {
    await backfillShop(shopDomain, mode === "DRY_RUN");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
