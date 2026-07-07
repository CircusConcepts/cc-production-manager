import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import styles from "./ResizableListsTable.module.css";

export interface ResizableColumn {
  key: string;
  label: string;
  width: number;
  minWidth?: number;
  wrap?: boolean;
}

export interface ResizableRow {
  id: string;
  cells: Record<string, ReactNode>;
}

interface ResizableListsTableProps {
  storageKey: string;
  columns: ResizableColumn[];
  rows: ResizableRow[];
}

const MIN_COL_WIDTH = 80;
const MIN_ROW_HEIGHT = 36;

function loadColumnWidths(
  storageKey: string,
  columns: ResizableColumn[],
): Record<string, number> {
  if (typeof window === "undefined") {
    return Object.fromEntries(columns.map((column) => [column.key, column.width]));
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return Object.fromEntries(columns.map((column) => [column.key, column.width]));
    }

    const parsed = JSON.parse(raw) as Record<string, number>;
    return Object.fromEntries(
      columns.map((column) => [
        column.key,
        Math.max(column.minWidth ?? MIN_COL_WIDTH, parsed[column.key] ?? column.width),
      ]),
    );
  } catch {
    return Object.fromEntries(columns.map((column) => [column.key, column.width]));
  }
}

export function ResizableListsTable({
  storageKey,
  columns,
  rows,
}: ResizableListsTableProps) {
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    loadColumnWidths(storageKey, columns),
  );
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});
  const resizeState = useRef<
    | {
        type: "column";
        key: string;
        startX: number;
        startWidth: number;
      }
    | {
        type: "row";
        rowId: string;
        startY: number;
        startHeight: number;
      }
    | null
  >(null);

  useEffect(() => {
    setColumnWidths(loadColumnWidths(storageKey, columns));
  }, [storageKey, columns]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, JSON.stringify(columnWidths));
  }, [columnWidths, storageKey]);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const state = resizeState.current;
    if (!state) return;

    if (state.type === "column") {
      const delta = event.clientX - state.startX;
      const column = columns.find((entry) => entry.key === state.key);
      const minWidth = column?.minWidth ?? MIN_COL_WIDTH;
      setColumnWidths((current) => ({
        ...current,
        [state.key]: Math.max(minWidth, state.startWidth + delta),
      }));
      return;
    }

    const delta = event.clientY - state.startY;
    setRowHeights((current) => ({
      ...current,
      [state.rowId]: Math.max(MIN_ROW_HEIGHT, state.startHeight + delta),
    }));
  }, [columns]);

  const onPointerUp = useCallback(() => {
    resizeState.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const startColumnResize = useCallback(
    (key: string, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      resizeState.current = {
        type: "column",
        key,
        startX: event.clientX,
        startWidth: columnWidths[key] ?? MIN_COL_WIDTH,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [columnWidths, onPointerMove, onPointerUp],
  );

  const startRowResize = useCallback(
    (rowId: string, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startHeight = rowHeights[rowId] ?? MIN_ROW_HEIGHT;
      resizeState.current = {
        type: "row",
        rowId,
        startY: event.clientY,
        startHeight,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp, rowHeights],
  );

  const tableWidth = useMemo(
    () =>
      columns.reduce(
        (sum, column) => sum + (columnWidths[column.key] ?? column.width),
        0,
      ),
    [columnWidths, columns],
  );

  return (
    <div className={styles.resizableTableWrapper}>
      <table className={styles.resizableTable} style={{ width: tableWidth }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: columnWidths[column.key] ?? column.width }}
              >
                <div className={styles.headerContent}>{column.label}</div>
                <div
                  className={styles.colResizeHandle}
                  onPointerDown={(event) => startColumnResize(column.key, event)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowHeight = rowHeights[row.id] ?? MIN_ROW_HEIGHT;

            return (
              <tr key={row.id} style={{ height: rowHeight }}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{
                      width: columnWidths[column.key] ?? column.width,
                      height: rowHeight,
                    }}
                  >
                    <div
                      className={column.wrap ? styles.cellWrap : styles.cellInner}
                    >
                      {row.cells[column.key]}
                    </div>
                    {column.key === columns[columns.length - 1]?.key && (
                      <div
                        className={styles.rowResizeHandle}
                        onPointerDown={(event) => startRowResize(row.id, event)}
                      />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const DEFAULT_LISTS_TABLE_COLUMNS: ResizableColumn[] = [
  { key: "sku", label: "SKU", width: 110 },
  { key: "productName", label: "Product Name", width: 180 },
  { key: "serialNumber", label: "Serial Number", width: 170 },
  { key: "orderNumber", label: "Order #", width: 130 },
  { key: "color", label: "Color", width: 120 },
  { key: "size", label: "Size", width: 100 },
  { key: "employee", label: "Employee", width: 140 },
  { key: "notes", label: "Notes", width: 240, wrap: true },
  { key: "updated", label: "Updated", width: 160 },
  { key: "updateStatus", label: "Update Status", width: 180 },
  { key: "edit", label: "Edit", width: 100 },
  { key: "delete", label: "Delete", width: 120 },
];
