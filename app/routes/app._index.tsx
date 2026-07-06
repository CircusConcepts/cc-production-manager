import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import db from "../db.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const [
    productCount,
    itemCount,
    inStockCount,
    inProductionCount,
    inQcCount,
    readyCount,
  ] = await Promise.all([
    db.product.count({ where: { shopId: shop.id } }),
    db.serializedItem.count({ where: { shopId: shop.id } }),
    db.serializedItem.count({ where: { shopId: shop.id, status: "IN_STOCK" } }),
    db.serializedItem.count({
      where: { shopId: shop.id, status: "IN_PRODUCTION" },
    }),
    db.serializedItem.count({ where: { shopId: shop.id, status: "QC" } }),
    db.serializedItem.count({ where: { shopId: shop.id, status: "READY" } }),
  ]);

  return {
    productCount,
    itemCount,
    inStockCount,
    inProductionCount,
    inQcCount,
    readyCount,
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Production Manager">
      <s-section heading="Overview">
        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Products</s-heading>
            <s-text>{data.productCount}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Serialized Items</s-heading>
            <s-text>{data.itemCount}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>In Stock</s-heading>
            <s-text>{data.inStockCount}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>In Production</s-heading>
            <s-text>{data.inProductionCount}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>In QC</s-heading>
            <s-text>{data.inQcCount}</s-text>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-heading>Ready</s-heading>
            <s-text>{data.readyCount}</s-text>
          </s-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}
