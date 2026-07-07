#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function printUsage() {
  console.log(`Usage:
  node scripts/check-duplicate-product-serials.mjs <shop-domain>

Example:
  node --env-file=.env scripts/check-duplicate-product-serials.mjs circusconcepts.myshopify.com

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

async function checkDuplicateProductSerials(shopDomain) {
  const shop = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true, shop: true, name: true },
  });

  if (!shop) {
    console.error(`Shop not found: ${shopDomain}`);
    process.exit(1);
  }

  const items = await prisma.serializedItem.findMany({
    where: { shopId: shop.id },
    select: {
      id: true,
      productId: true,
      serialNumber: true,
      product: {
        select: { sku: true, name: true },
      },
    },
    orderBy: [{ product: { sku: "asc" } }, { serialNumber: "asc" }],
  });

  const groups = new Map();

  for (const item of items) {
    const key = `${item.productId}::${item.serialNumber}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const duplicates = [...groups.entries()].filter(([, group]) => group.length > 1);

  if (duplicates.length === 0) {
    console.log(
      `No duplicate productId + serialNumber rows found for ${shop.shop}.`,
    );
    return;
  }

  console.error(
    `Found ${duplicates.length} duplicate productId + serialNumber group(s) for ${shop.shop}:`,
  );

  for (const [, group] of duplicates) {
    const sample = group[0];
    console.error(
      `- SKU ${sample.product.sku} (${sample.product.name}) serial ${sample.serialNumber}: ${group.length} rows`,
    );
    for (const item of group) {
      console.error(`    item ${item.id}`);
    }
  }

  process.exit(1);
}

async function main() {
  const shopDomain = process.argv[2];

  if (!shopDomain) {
    printUsage();
    await listShops();
    return;
  }

  await checkDuplicateProductSerials(shopDomain);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
