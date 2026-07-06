import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

function parseScopes(scopeString: string): string[] {
  if (!scopeString) return [];
  return scopeString.split(",").map((scope) => scope.trim()).filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const scopes = parseScopes(session.scope ?? "");

  return {
    shopDomain: shop.shop,
    shopName: shop.name,
    scopes: scopes.join(", ") || "None",
    hasWriteScope: scopes.some((scope) => scope.startsWith("write_")),
    hasReadOrders: scopes.includes("read_orders"),
  };
};

export default function SettingsPage() {
  const { shopDomain, shopName, scopes, hasWriteScope, hasReadOrders } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Shop">
        <s-stack direction="block" gap="base">
          <s-text>Domain: {shopDomain}</s-text>
          {shopName && <s-text>Name: {shopName}</s-text>}
        </s-stack>
      </s-section>

      <s-section heading="Shopify safety">
        <s-stack direction="block" gap="base">
          <s-text>Granted scopes: {scopes}</s-text>
          <s-text>This app currently requests read_products only.</s-text>
          <s-text>
            This app does not request Shopify write permissions.
          </s-text>
          <s-text>
            Creating Production SKUs does not create Shopify products.
          </s-text>
          <s-text>CSV imports write only to PostgreSQL.</s-text>
        </s-stack>

        {hasWriteScope && (
          <s-banner tone="critical" heading="Unsafe scope detected">
            Unsafe Shopify write scope detected. Remove this before live use.
          </s-banner>
        )}

        {hasReadOrders && (
          <s-banner tone="warning" heading="Order access enabled">
            Order access is enabled. This may require protected customer data
            approval.
          </s-banner>
        )}
      </s-section>
    </s-page>
  );
}
