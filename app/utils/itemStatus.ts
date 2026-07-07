import type { ItemStatus } from "@prisma/client";

export function isStockOrderNumber(value: string | null | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "stock";
}

export function resolveStatusForOrderNumber({
  orderNumber,
  requestedStatus,
}: {
  orderNumber?: string | null;
  requestedStatus?: ItemStatus;
}): ItemStatus {
  if (isStockOrderNumber(orderNumber)) return "IN_STOCK";
  return requestedStatus ?? "IN_STOCK";
}

export function resolveDefaultStatus(
  orderNumber: string | undefined,
  status?: ItemStatus,
): ItemStatus {
  if (isStockOrderNumber(orderNumber)) return "IN_STOCK";
  if (status) return status;
  if (orderNumber) return "SHIPPED";
  return "IN_STOCK";
}
