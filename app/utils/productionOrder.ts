import type { ProductionOrderStatus } from "@prisma/client";

export const PRODUCTION_ORDER_STATUS_LABELS: Record<
  ProductionOrderStatus,
  string
> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  PARTIALLY_DONE: "Partially done",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const PRODUCTION_ORDER_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "PARTIALLY_DONE",
  "DONE",
  "CANCELLED",
] as const satisfies readonly ProductionOrderStatus[];

export function formatProductionOrderStatus(
  status: ProductionOrderStatus,
): string {
  return PRODUCTION_ORDER_STATUS_LABELS[status] ?? status;
}

export function getProductionOrderStatusOptions(): Array<{
  value: ProductionOrderStatus;
  label: string;
}> {
  return PRODUCTION_ORDER_STATUSES.map((value) => ({
    value,
    label: formatProductionOrderStatus(value),
  }));
}

export function isProductionOrderStatus(
  value: string,
): value is ProductionOrderStatus {
  return (PRODUCTION_ORDER_STATUSES as readonly string[]).includes(value);
}

export type ProductionOrderItemInput = {
  id?: string;
  productId: string;
  quantity: number;
  colorId: string;
  size: string;
};

export type CalendarDateParseResult =
  | { ok: true; date: Date }
  | { ok: false; error: string };

export function parseCalendarDate(value: string): CalendarDateParseResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "Date is required." };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: "Date must use YYYY-MM-DD format." };
  }

  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: "Date is invalid." };
  }

  return { ok: true, date };
}

export function parseOptionalCalendarDate(
  value: string,
): CalendarDateParseResult | { ok: true; date: null } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, date: null };
  }
  return parseCalendarDate(trimmed);
}

export function formatCalendarDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTodayCalendarDate(): string {
  const now = new Date();
  return formatCalendarDate(
    new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
  );
}

export function isProductionOrderOverdue(
  dueDate: Date | null | undefined,
  status: ProductionOrderStatus,
): boolean {
  if (!dueDate || status === "DONE" || status === "CANCELLED") {
    return false;
  }

  const today = getTodayCalendarDate();
  const due = formatCalendarDate(dueDate);
  return due < today;
}

export function compareDueDateAsc(
  a: { dueDate: string | null; updatedAt: string },
  b: { dueDate: string | null; updatedAt: string },
): number {
  if (a.dueDate === null && b.dueDate === null) {
    return b.updatedAt.localeCompare(a.updatedAt);
  }
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  const dueCompare = a.dueDate.localeCompare(b.dueDate);
  if (dueCompare !== 0) return dueCompare;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function formatProductLineSummary(
  lines: Array<{ sku: string | null; quantity: number }>,
): string {
  if (lines.length === 0) return "—";
  return lines
    .map((line) => `${line.sku ?? "Unknown"} × ${line.quantity}`)
    .join(", ");
}

export function sanitizeDisplayFilename(name: string): string {
  const base = name.replace(/[/\\]/g, "_");
  const withoutControl = [...base]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");
  const trimmed = withoutControl.trim();
  return trimmed || "document";
}

export function formatDuplicateOrderNumberError(): string {
  return "A production order with this order number already exists.";
}
