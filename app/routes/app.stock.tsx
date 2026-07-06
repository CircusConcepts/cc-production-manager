import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import db from "../db.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const products = await db.product.findMany({
    where: {
      shopId: shop.id,
      items: { some: { status: "IN_STOCK" } },
    },
    orderBy: { name: "asc" },
    include: {
      items: {
        where: { status: "IN_STOCK" },
        select: { serialNumber: true },
        orderBy: { serialNumber: "asc" },
      },
    },
  });

  const stockByProduct = products.map((product) => ({
    sku: product.sku,
    name: product.name,
    quantityInStock: product.items.length,
    serialNumbers: product.items.map((item) => item.serialNumber),
  }));

  const totalInStock = stockByProduct.reduce(
    (sum, row) => sum + row.quantityInStock,
    0,
  );

  return { stockByProduct, totalInStock };
};

export default function StockPage() {
  const { stockByProduct, totalInStock } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Stock">
      <s-section heading={`In stock: ${totalInStock} items`}>
        <s-text>
          Counts are based on items marked &quot;In stock&quot;. Each item has
          its own serial number.
        </s-text>

        {stockByProduct.length === 0 ? (
          <s-text>Nothing in stock right now.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Product Name</s-table-header>
              <s-table-header>Qty In Stock</s-table-header>
              <s-table-header>Serial Numbers</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {stockByProduct.map((row) => (
                <s-table-row key={row.sku}>
                  <s-table-cell>{row.sku}</s-table-cell>
                  <s-table-cell>{row.name}</s-table-cell>
                  <s-table-cell>{row.quantityInStock}</s-table-cell>
                  <s-table-cell>{row.serialNumbers.join(", ")}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
