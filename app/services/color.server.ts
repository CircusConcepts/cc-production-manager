import db from "../db.server";
import { createAuditLog } from "./audit.server";

export function normalizeColorName(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export async function ensureColorByName(
  shopId: string,
  rawName: string,
): Promise<{ id: string; name: string } | null> {
  const name = normalizeColorName(rawName);
  if (!name) return null;

  const existing = await db.color.findFirst({
    where: {
      shopId,
      name: { equals: name, mode: "insensitive" },
    },
  });

  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  const color = await db.color.create({
    data: { shopId, name, active: true },
  });

  await createAuditLog({
    shopId,
    action: "color.created",
    entity: "Color",
    entityId: color.id,
    metadata: { name: color.name, source: "import_or_auto" },
  });

  return { id: color.id, name: color.name };
}

export async function findColorForShop(shopId: string, colorId: string) {
  return db.color.findFirst({
    where: { id: colorId, shopId, active: true },
  });
}
