import type { Prisma } from "@prisma/client";

import db from "../db.server";

export async function createAuditLog({
  shopId,
  action,
  entity,
  entityId,
  metadata,
}: {
  shopId: string;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return db.auditLog.create({
    data: {
      shopId,
      action,
      entity,
      entityId,
      metadata,
    },
  });
}
