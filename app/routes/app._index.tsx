import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import appLogo from "../../assets/App Logo.jpg";
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

const welcomeStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center" as const,
  padding: "16px 0 24px",
};

const logoStyle = {
  width: "72px",
  height: "auto",
  objectFit: "contain" as const,
  marginBottom: "12px",
};

const textStyle = {
  lineHeight: "1.6",
};

const finalLineStyle = {
  fontSize: "18px",
  fontWeight: 600,
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  return (
    <s-page heading="Production Manager">
      <div className="appWideSection">
        <s-section>
          <div style={welcomeStyle}>
            <img
              src={appLogo}
              alt="Production Manager App Logo"
              style={logoStyle}
            />
            <div style={textStyle}>
              <div>Hello from Ako</div>
              <div>and</div>
              <div style={finalLineStyle}>Welcome to Production Manager App</div>
            </div>
          </div>
        </s-section>

        <s-section heading="Overview">
          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>Products</s-heading>
              <s-text>{data.productCount}</s-text>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-heading>List items</s-heading>
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
      </div>
    </s-page>
  );
}
