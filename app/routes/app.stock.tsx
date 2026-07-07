import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import db from "../db.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const items = await db.serializedItem.findMany({
    where: {
      shopId: shop.id,
      status: "IN_STOCK",
    },
    orderBy: [{ product: { sku: "asc" } }, { serialNumber: "asc" }],
    include: {
      product: {
        select: { sku: true, name: true },
      },
    },
  });

  const stockRows = items.map((item) => ({
    id: item.id,
    sku: item.product.sku,
    productName: item.product.name,
    serialNumber: item.serialNumber,
    color: item.color,
    size: item.size,
    employee: item.madeBy,
    orderNumber: item.orderNumber,
  }));

  const totalInStock = stockRows.length;

  return { stockRows, totalInStock };
};

export default function StockPage() {
  const { stockRows, totalInStock } = useLoaderData<typeof loader>();
  const [search, setSearch] = useState("");

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return stockRows;
    return stockRows.filter((row) => {
      const haystack = [
        row.sku,
        row.productName,
        row.serialNumber,
        row.color,
        row.size,
        row.employee,
        row.orderNumber,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [stockRows, search]);

  return (
    <s-page heading="Stock">
      <s-section heading={`In stock: ${totalInStock} items`}>
        <s-text>
          Counts are based on items marked &quot;In stock&quot; in this app
          database only. Shopify inventory is not updated.
        </s-text>

        <s-text-field
          label="Search stock"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
          autocomplete="off"
        />

        {stockRows.length === 0 ? (
          <s-text>Nothing in stock right now.</s-text>
        ) : filteredRows.length === 0 ? (
          <s-text>No stock items match your search.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Product Name</s-table-header>
              <s-table-header>Serial Number</s-table-header>
              <s-table-header>Color</s-table-header>
              <s-table-header>Size</s-table-header>
              <s-table-header>Employee</s-table-header>
              <s-table-header>Order #</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {filteredRows.map((row) => (
                <s-table-row key={row.id}>
                  <s-table-cell>{row.sku}</s-table-cell>
                  <s-table-cell>{row.productName}</s-table-cell>
                  <s-table-cell>{row.serialNumber}</s-table-cell>
                  <s-table-cell>{row.color ?? "—"}</s-table-cell>
                  <s-table-cell>{row.size ?? "—"}</s-table-cell>
                  <s-table-cell>{row.employee ?? "—"}</s-table-cell>
                  <s-table-cell>{row.orderNumber ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
