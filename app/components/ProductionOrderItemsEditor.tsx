import { useEffect, useMemo, useState } from "react";

import type { ProductionOrderItemInput } from "../utils/productionOrder";
import "../styles/production-orders.css";

type ProductOption = {
  id: string;
  sku: string;
  name: string;
};

type ColorOption = {
  id: string;
  name: string;
};

type EditorRow = {
  key: string;
  id?: string;
  productId: string;
  quantity: number;
  colorId: string;
  size: string;
};

type ProductionOrderItemsEditorProps = {
  products: ProductOption[];
  colors: ColorOption[];
  initialItems?: ProductionOrderItemInput[];
  itemsJsonName?: string;
};

function createEmptyRow(): EditorRow {
  return {
    key: crypto.randomUUID(),
    productId: "",
    quantity: 1,
    colorId: "",
    size: "",
  };
}

function toEditorRows(initialItems?: ProductionOrderItemInput[]): EditorRow[] {
  if (!initialItems || initialItems.length === 0) {
    return [createEmptyRow()];
  }

  return initialItems.map((item) => ({
    key: item.id ?? crypto.randomUUID(),
    id: item.id,
    productId: item.productId,
    quantity: item.quantity,
    colorId: item.colorId,
    size: item.size,
  }));
}

function serializeRows(rows: EditorRow[]): string {
  const items: ProductionOrderItemInput[] = rows
    .filter((row) => row.productId.trim().length > 0)
    .map((row) => ({
      id: row.id,
      productId: row.productId,
      quantity: row.quantity,
      colorId: row.colorId,
      size: row.size,
    }));

  return JSON.stringify(items);
}

export function ProductionOrderItemsEditor({
  products,
  colors,
  initialItems,
  itemsJsonName = "orderItemsJson",
}: ProductionOrderItemsEditorProps) {
  const [rows, setRows] = useState<EditorRow[]>(() => toEditorRows(initialItems));
  const [itemsJson, setItemsJson] = useState(() =>
    serializeRows(toEditorRows(initialItems)),
  );

  const productMap = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  useEffect(() => {
    setItemsJson(serializeRows(rows));
  }, [rows]);

  function updateRow(key: string, patch: Partial<EditorRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    setRows((current) => [...current, createEmptyRow()]);
  }

  function removeRow(key: string) {
    setRows((current) => {
      if (current.length === 1) {
        return [createEmptyRow()];
      }
      return current.filter((row) => row.key !== key);
    });
  }

  return (
    <div className="orderItemsEditor">
      <input type="hidden" name={itemsJsonName} value={itemsJson} readOnly />

      {rows.map((row, index) => {
        const product = row.productId ? productMap.get(row.productId) : null;
        const rowLabel = `Order item ${index + 1}`;

        return (
          <div key={row.key} className="orderItemRow">
            <div className="orderItemField">
              <label className="orderItemLabel" htmlFor={`product-${row.key}`}>
                Product
              </label>
              <select
                id={`product-${row.key}`}
                className="orderItemNativeSelect"
                value={row.productId}
                onChange={(event) =>
                  updateRow(row.key, { productId: event.currentTarget.value })
                }
              >
                <option value="">Select a product</option>
                {products.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.sku} — {option.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="orderItemField">
              <span className="orderItemLabel">SKU</span>
              <div className="orderItemReadonly" aria-label={`${rowLabel} SKU`}>
                {product?.sku ?? "—"}
              </div>
            </div>

            <div className="orderItemField">
              <span className="orderItemLabel">Product name</span>
              <div
                className="orderItemReadonly"
                aria-label={`${rowLabel} product name`}
              >
                {product?.name ?? "—"}
              </div>
            </div>

            <div className="orderItemField">
              <label className="orderItemLabel" htmlFor={`quantity-${row.key}`}>
                Quantity
              </label>
              <input
                id={`quantity-${row.key}`}
                className="orderItemNativeInput"
                type="number"
                min={1}
                max={10000}
                step={1}
                value={row.quantity}
                onChange={(event) => {
                  const next = Number.parseInt(event.currentTarget.value, 10);
                  updateRow(row.key, {
                    quantity: Number.isFinite(next) && next > 0 ? next : 1,
                  });
                }}
              />
            </div>

            <div className="orderItemField">
              <label className="orderItemLabel" htmlFor={`color-${row.key}`}>
                Color
              </label>
              <select
                id={`color-${row.key}`}
                className="orderItemNativeSelect"
                value={row.colorId}
                onChange={(event) =>
                  updateRow(row.key, { colorId: event.currentTarget.value })
                }
              >
                <option value="">No color</option>
                {colors.map((color) => (
                  <option key={color.id} value={color.id}>
                    {color.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="orderItemField">
              <label className="orderItemLabel" htmlFor={`size-${row.key}`}>
                Size
              </label>
              <input
                id={`size-${row.key}`}
                className="orderItemNativeInput"
                type="text"
                value={row.size}
                onChange={(event) =>
                  updateRow(row.key, { size: event.currentTarget.value })
                }
                autoComplete="off"
              />
            </div>

            <div className="orderItemActions">
              <s-button
                type="button"
                variant="tertiary"
                tone="critical"
                onClick={() => removeRow(row.key)}
              >
                Remove {rowLabel.toLowerCase()}
              </s-button>
            </div>
          </div>
        );
      })}

      <s-button type="button" variant="secondary" onClick={addRow}>
        Add another product
      </s-button>
    </div>
  );
}
