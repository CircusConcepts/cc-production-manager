import db from "../db.server";

export async function getOrCreateShop(shopDomain: string) {
  return db.shop.upsert({
    where: { shop: shopDomain },
    update: {},
    create: {
      shop: shopDomain,
    },
  });
}