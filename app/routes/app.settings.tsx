import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  return {
    shopDomain: shop.shop,
    shopName: shop.name,
    scopes: session.scope ?? "",
  };
};

export default function SettingsPage() {
  const { shopDomain, shopName, scopes } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Shop">
        <s-stack direction="block" gap="base">
          <s-text>Domain: {shopDomain}</s-text>
          {shopName && <s-text>Name: {shopName}</s-text>}
        </s-stack>
      </s-section>
      <s-section heading="Shopify access">
        <s-text>
          This app is read-only toward Shopify. Granted scopes: {scopes}
        </s-text>
      </s-section>
    </s-page>
  );
}
