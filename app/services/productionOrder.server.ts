import { Prisma } from "@prisma/client";
import { z } from "zod";

import db from "../db.server";
import { normalizeSku } from "../utils/sku";
import { createAuditLog } from "./audit.server";
import {
  CIRCUS_ORDER_PDF_PARSER_VERSION,
  type ParsedCircusOrderLine,
  type ParsedCircusOrderPdf,
} from "./circusOrderPdfParser.server";
import {
  deleteOrderDocument,
  saveOrderDocument,
  validateOrderDocumentUploads,
  type ValidatedOrderDocument,
} from "./orderDocumentStorage.server";
import {
  formatDuplicateOrderNumberError,
  isProductionOrderStatus,
  parseCalendarDate,
  type ProductionOrderItemInput,
} from "../utils/productionOrder";

const productionOrderStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "PARTIALLY_DONE",
  "DONE",
  "CANCELLED",
]);

const orderItemSchema = z.object({
  id: z.string().trim().optional(),
  productId: z.string().trim().min(1, "Product is required."),
  quantity: z
    .number()
    .int("Quantity must be a whole number.")
    .min(1, "Quantity must be at least 1.")
    .max(10_000, "Quantity cannot exceed 10,000."),
  colorId: z.string(),
  size: z.string(),
});

const orderItemsSchema = z
  .array(orderItemSchema)
  .min(1, "At least one order item is required.");

export type ProductionOrderFormInput = {
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  orderNote: string;
  orderDate: string;
  dueDate: string;
  employee: string;
  status: string;
};

export type ActionValidationResult =
  | {
      ok: true;
      data: {
        orderNumber: string;
        customerName: string;
        customerAddress: string | null;
        orderNote: string | null;
        orderDate: Date;
        dueDate: Date | null;
        employee: string | null;
        status: z.infer<typeof productionOrderStatusSchema>;
        items: ProductionOrderItemInput[];
      };
    }
  | { ok: false; error: string };

export function parseOrderItemsJson(
  raw: string,
): { ok: true; items: ProductionOrderItemInput[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Order items are invalid." };
  }

  const result = orderItemsSchema.safeParse(parsed);
  if (!result.success) {
    const message =
      result.error.issues[0]?.message ?? "Order items are invalid.";
    return { ok: false, error: message };
  }

  return {
    ok: true,
    items: result.data.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      colorId: item.colorId.trim(),
      size: item.size.trim(),
    })),
  };
}

export function validateProductionOrderForm(
  input: ProductionOrderFormInput,
  items: ProductionOrderItemInput[],
  options?: { requireDueDate?: boolean },
): ActionValidationResult {
  const requireDueDate = options?.requireDueDate ?? false;

  const orderNumber = input.orderNumber.trim();
  const customerName = input.customerName.trim();
  const customerAddress = input.customerAddress.trim();
  const orderNote = input.orderNote.trim();
  const employee = input.employee.trim();
  const statusRaw = input.status.trim();

  if (!orderNumber) {
    return { ok: false, error: "Order number is required." };
  }
  if (!customerName) {
    return { ok: false, error: "Customer name is required." };
  }
  if (!isProductionOrderStatus(statusRaw)) {
    return { ok: false, error: "Status is invalid." };
  }

  const orderDateResult = parseCalendarDate(input.orderDate);
  if (!orderDateResult.ok) {
    return { ok: false, error: "Order date is invalid." };
  }

  const dueDateTrimmed = input.dueDate.trim();
  let dueDate: Date | null = null;
  if (dueDateTrimmed) {
    const dueDateResult = parseCalendarDate(dueDateTrimmed);
    if (!dueDateResult.ok) {
      return { ok: false, error: "Due date is invalid." };
    }
    dueDate = dueDateResult.date;
  } else if (requireDueDate) {
    return { ok: false, error: "Due date is required." };
  }

  if (
    dueDate &&
    formatCalendarDate(dueDate) < formatCalendarDate(orderDateResult.date)
  ) {
    return { ok: false, error: "Due date cannot be before order date." };
  }

  const itemsResult = orderItemsSchema.safeParse(items);
  if (!itemsResult.success) {
    const message =
      itemsResult.error.issues[0]?.message ?? "Order items are invalid.";
    return { ok: false, error: message };
  }

  return {
    ok: true,
    data: {
      orderNumber,
      customerName,
      customerAddress: customerAddress || null,
      orderNote: orderNote || null,
      orderDate: orderDateResult.date,
      dueDate,
      employee: employee || null,
      status: statusRaw,
      items: itemsResult.data.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        colorId: item.colorId.trim(),
        size: item.size.trim(),
      })),
    },
  };
}

function formatCalendarDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getDistinctEmployeeNames(
  shopId: string,
): Promise<string[]> {
  const rows = await db.serializedItem.findMany({
    where: {
      shopId,
      madeBy: { not: null },
    },
    select: { madeBy: true },
    distinct: ["madeBy"],
    orderBy: { madeBy: "asc" },
  });

  return rows
    .map((row) => row.madeBy?.trim() ?? "")
    .filter((name) => name.length > 0);
}

type ResolvedLine = {
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  colorId: string | null;
  colorName: string | null;
  size: string | null;
  customProperties: Prisma.InputJsonValue | null;
};

export type ResolvedPdfImportLine = ResolvedLine & {
  pdfDescription: string;
  options: Array<{ label: string; value: string }>;
};

export async function checkDuplicateProductionOrderNumber(
  shopId: string,
  orderNumber: string,
): Promise<{ ok: false; error: string } | null> {
  const existing = await db.productionOrder.findFirst({
    where: { shopId, orderNumber },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, error: formatDuplicateOrderNumberError() };
  }
  return null;
}

function buildLineCustomProperties(
  parsedLine: ParsedCircusOrderLine,
): Prisma.InputJsonValue {
  const payload: Record<string, unknown> = {
    source: "circus_order_pdf",
    pdfDescription: parsedLine.pdfDescription,
    options: parsedLine.options,
  };

  if (parsedLine.model) {
    payload.pdfModel = parsedLine.model;
  }

  return payload as Prisma.InputJsonValue;
}

export async function resolveParsedPdfLinesForShop({
  shopId,
  lines,
}: {
  shopId: string;
  lines: ParsedCircusOrderLine[];
}): Promise<
  | { ok: true; lines: ResolvedPdfImportLine[] }
  | { ok: false; error: string }
> {
  const requestedColors = [
    ...new Set(
      lines
        .map((line) => line.colorName?.trim() ?? "")
        .filter((name) => name.length > 0),
    ),
  ];

  const [products, colors] = await Promise.all([
    db.product.findMany({
      where: { shopId, active: true },
      select: { id: true, sku: true, name: true },
    }),
    requestedColors.length > 0
      ? db.color.findMany({
          where: { shopId, active: true },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const productBySku = new Map<string, (typeof products)[number]>();
  for (const product of products) {
    const key = normalizeSku(product.sku);
    if (!productBySku.has(key)) {
      productBySku.set(key, product);
    }
  }

  const colorByName = new Map<string, (typeof colors)[number]>();
  for (const color of colors) {
    colorByName.set(color.name.trim().toLowerCase(), color);
  }

  const missingProducts: string[] = [];
  const missingColors: string[] = [];
  const resolvedLines: ResolvedPdfImportLine[] = [];

  for (const line of lines) {
    const normalizedSku = normalizeSku(line.sku);
    const product = productBySku.get(normalizedSku);
    if (!product) {
      missingProducts.push(line.sku);
      continue;
    }

    let colorId: string | null = null;
    let colorName: string | null = null;
    if (line.colorName) {
      const color = colorByName.get(line.colorName.trim().toLowerCase());
      if (!color) {
        missingColors.push(line.colorName);
        continue;
      }
      colorId = color.id;
      colorName = color.name;
    }

    resolvedLines.push({
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      quantity: line.quantity,
      colorId,
      colorName,
      size: line.size,
      customProperties: buildLineCustomProperties(line),
      pdfDescription: line.pdfDescription,
      options: line.options,
    });
  }

  if (missingProducts.length > 0) {
    const unique = [...new Set(missingProducts)];
    return {
      ok: false,
      error: `The following PDF products do not exist in Products: ${unique.join(", ")}. Add or correct these products before importing this order.`,
    };
  }

  if (missingColors.length > 0) {
    const unique = [...new Set(missingColors)];
    return {
      ok: false,
      error: `The following PDF colors do not exist in Colors: ${unique.join(", ")}. Add or correct these colors before importing this order.`,
    };
  }

  if (resolvedLines.length !== lines.length) {
    return {
      ok: false,
      error: "One or more PDF product lines could not be resolved.",
    };
  }

  return { ok: true, lines: resolvedLines };
}

export async function resolveOrderLinesForShop({
  shopId,
  items,
}: {
  shopId: string;
  items: ProductionOrderItemInput[];
}): Promise<{ ok: true; lines: ResolvedLine[] } | { ok: false; error: string }> {
  const productIds = [...new Set(items.map((item) => item.productId))];
  const colorIds = [
    ...new Set(items.map((item) => item.colorId).filter((id) => id.length > 0)),
  ];

  const [products, colors] = await Promise.all([
    db.product.findMany({
      where: {
        shopId,
        id: { in: productIds },
        active: true,
      },
      select: { id: true, sku: true, name: true },
    }),
    colorIds.length > 0
      ? db.color.findMany({
          where: {
            shopId,
            id: { in: colorIds },
            active: true,
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const productMap = new Map(products.map((product) => [product.id, product]));
  const colorMap = new Map(colors.map((color) => [color.id, color]));

  const lines: ResolvedLine[] = [];

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      return {
        ok: false,
        error: "One or more selected products are invalid for this shop.",
      };
    }

    let colorId: string | null = null;
    let colorName: string | null = null;
    if (item.colorId) {
      const color = colorMap.get(item.colorId);
      if (!color) {
        return {
          ok: false,
          error: "One or more selected colors are invalid for this shop.",
        };
      }
      colorId = color.id;
      colorName = color.name;
    }

    lines.push({
      productId: product.id,
      sku: product.sku,
      productName: product.name,
      quantity: item.quantity,
      colorId,
      colorName,
      size: item.size || null,
      customProperties: null,
    });
  }

  return { ok: true, lines };
}

export async function createProductionOrderWithLines({
  shopId,
  orderData,
  lines,
  documents,
  auditMetadata,
}: {
  shopId: string;
  orderData: {
    orderNumber: string;
    customerName: string;
    customerAddress: string | null;
    orderNote: string | null;
    orderDate: Date;
    dueDate: Date | null;
    employee: string | null;
    status: z.infer<typeof productionOrderStatusSchema>;
  };
  lines: ResolvedLine[];
  documents: ValidatedOrderDocument[];
  auditMetadata?: Prisma.InputJsonValue;
}) {
  const existing = await db.productionOrder.findFirst({
    where: { shopId, orderNumber: orderData.orderNumber },
    select: { id: true },
  });
  if (existing) {
    return { ok: false as const, error: formatDuplicateOrderNumberError() };
  }

  const order = await db.$transaction(async (tx) => {
    const created = await tx.productionOrder.create({
      data: {
        shopId,
        orderNumber: orderData.orderNumber,
        status: orderData.status,
        customerName: orderData.customerName,
        customerAddress: orderData.customerAddress,
        orderNote: orderData.orderNote,
        orderDate: orderData.orderDate,
        dueDate: orderData.dueDate,
        employee: orderData.employee,
        lines: {
          create: lines.map((line) => ({
            shopId,
            productId: line.productId,
            sku: line.sku,
            productName: line.productName,
            quantity: line.quantity,
            colorId: line.colorId,
            colorName: line.colorName,
            size: line.size,
            customProperties: line.customProperties ?? undefined,
          })),
        },
      },
      include: {
        lines: true,
      },
    });
    return created;
  });

  const savedStorageKeys: string[] = [];

  try {
    const documentRows: Array<{
      shopId: string;
      productionOrderId: string;
      originalName: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];

    for (const document of documents) {
      const { storageKey } = await saveOrderDocument({
        shopId,
        productionOrderId: order.id,
        file: document.file,
        extension: document.extension,
      });
      savedStorageKeys.push(storageKey);
      documentRows.push({
        shopId,
        productionOrderId: order.id,
        originalName: document.file.name.trim() || "document",
        storageKey,
        mimeType: document.mimeType,
        sizeBytes: document.file.size,
      });
    }

    if (documentRows.length > 0) {
      await db.productionOrderDocument.createMany({ data: documentRows });
    }

    const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
    await createAuditLog({
      shopId,
      action: "production_order.created",
      entity: "ProductionOrder",
      entityId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        status: order.status,
        productLineCount: lines.length,
        totalQuantity,
        documentCount: documentRows.length,
        orderDate: formatCalendarDate(orderData.orderDate),
        dueDate: orderData.dueDate
          ? formatCalendarDate(orderData.dueDate)
          : null,
        ...(auditMetadata &&
        typeof auditMetadata === "object" &&
        !Array.isArray(auditMetadata)
          ? auditMetadata
          : {}),
      },
    });

    return { ok: true as const, order };
  } catch (error) {
    for (const storageKey of savedStorageKeys) {
      await deleteOrderDocument(storageKey).catch(() => undefined);
    }
    await db.productionOrder.delete({ where: { id: order.id } }).catch(() => undefined);

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: false as const, error: formatDuplicateOrderNumberError() };
    }

    throw error;
  }
}

export async function findProductionOrderForShop({
  shopId,
  orderId,
}: {
  shopId: string;
  orderId: string;
}) {
  return db.productionOrder.findFirst({
    where: { id: orderId, shopId },
    include: {
      lines: {
        orderBy: { createdAt: "asc" },
        include: {
          _count: { select: { items: true } },
        },
      },
      documents: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

export async function updateProductionOrderWithLines({
  shopId,
  orderId,
  orderData,
  items,
}: {
  shopId: string;
  orderId: string;
  orderData: {
    orderNumber: string;
    customerName: string;
    customerAddress: string | null;
    orderNote: string | null;
    orderDate: Date;
    dueDate: Date | null;
    employee: string | null;
    status: z.infer<typeof productionOrderStatusSchema>;
  };
  items: ProductionOrderItemInput[];
}) {
  const existingOrder = await findProductionOrderForShop({ shopId, orderId });
  if (!existingOrder) {
    return { ok: false as const, error: "Production order not found." };
  }

  if (orderData.orderNumber !== existingOrder.orderNumber) {
    const duplicate = await db.productionOrder.findFirst({
      where: {
        shopId,
        orderNumber: orderData.orderNumber,
        NOT: { id: orderId },
      },
      select: { id: true },
    });
    if (duplicate) {
      return { ok: false as const, error: formatDuplicateOrderNumberError() };
    }
  }

  const resolved = await resolveOrderLinesForShop({ shopId, items });
  if (!resolved.ok) {
    return resolved;
  }

  const existingLineMap = new Map(
    existingOrder.lines.map((line) => [line.id, line]),
  );
  const submittedLineIds = new Set(
    items.map((item) => item.id).filter((id): id is string => Boolean(id)),
  );

  for (const item of items) {
    if (item.id && !existingLineMap.has(item.id)) {
      return {
        ok: false as const,
        error: "One or more order lines are invalid for this order.",
      };
    }
  }

  const linesToDelete = existingOrder.lines.filter(
    (line) => !submittedLineIds.has(line.id),
  );

  for (const line of linesToDelete) {
    if (line._count.items > 0) {
      return {
        ok: false as const,
        error: `Cannot remove line "${line.sku ?? line.productName}" because serialized items are linked to it.`,
      };
    }
  }

  for (const item of items) {
    if (!item.id) continue;
    const existingLine = existingLineMap.get(item.id);
    if (!existingLine) continue;
    if (item.quantity < existingLine._count.items) {
      return {
        ok: false as const,
        error: `Quantity for "${existingLine.sku ?? existingLine.productName}" cannot be reduced below ${existingLine._count.items} because serialized items are linked to that line.`,
      };
    }
  }

  const previousStatus = existingOrder.status;

  try {
    const updated = await db.$transaction(async (tx) => {
      await tx.productionOrder.update({
        where: { id: orderId },
        data: {
          orderNumber: orderData.orderNumber,
          customerName: orderData.customerName,
          customerAddress: orderData.customerAddress,
          orderNote: orderData.orderNote,
          orderDate: orderData.orderDate,
          dueDate: orderData.dueDate,
          employee: orderData.employee,
          status: orderData.status,
        },
      });

      if (linesToDelete.length > 0) {
        await tx.productionOrderLine.deleteMany({
          where: {
            id: { in: linesToDelete.map((line) => line.id) },
            shopId,
            productionOrderId: orderId,
          },
        });
      }

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const resolvedLine = resolved.lines[index];
        if (item.id) {
          await tx.productionOrderLine.update({
            where: { id: item.id },
            data: {
              productId: resolvedLine.productId,
              sku: resolvedLine.sku,
              productName: resolvedLine.productName,
              quantity: resolvedLine.quantity,
              colorId: resolvedLine.colorId,
              colorName: resolvedLine.colorName,
              size: resolvedLine.size,
            },
          });
        } else {
          await tx.productionOrderLine.create({
            data: {
              shopId,
              productionOrderId: orderId,
              productId: resolvedLine.productId,
              sku: resolvedLine.sku,
              productName: resolvedLine.productName,
              quantity: resolvedLine.quantity,
              colorId: resolvedLine.colorId,
              colorName: resolvedLine.colorName,
              size: resolvedLine.size,
            },
          });
        }
      }

      return tx.productionOrder.findFirstOrThrow({
        where: { id: orderId, shopId },
        include: {
          lines: { orderBy: { createdAt: "asc" } },
          documents: { orderBy: { createdAt: "asc" } },
        },
      });
    });

    const totalQuantity = resolved.lines.reduce(
      (sum, line) => sum + line.quantity,
      0,
    );

    await createAuditLog({
      shopId,
      action: "production_order.updated",
      entity: "ProductionOrder",
      entityId: orderId,
      metadata: {
        orderNumber: updated.orderNumber,
        status: updated.status,
        productLineCount: resolved.lines.length,
        totalQuantity,
        orderDate: formatCalendarDate(orderData.orderDate),
        dueDate: orderData.dueDate
          ? formatCalendarDate(orderData.dueDate)
          : null,
      },
    });

    if (previousStatus !== orderData.status) {
      await createAuditLog({
        shopId,
        action: "production_order.status_changed",
        entity: "ProductionOrder",
        entityId: orderId,
        metadata: {
          orderNumber: updated.orderNumber,
          previousStatus,
          status: orderData.status,
        },
      });
    }

    return { ok: true as const, order: updated };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { ok: false as const, error: formatDuplicateOrderNumberError() };
    }
    throw error;
  }
}

export async function uploadProductionOrderDocuments({
  shopId,
  orderId,
  files,
}: {
  shopId: string;
  orderId: string;
  files: File[];
}) {
  const order = await db.productionOrder.findFirst({
    where: { id: orderId, shopId },
    select: {
      id: true,
      orderNumber: true,
      _count: { select: { documents: true } },
    },
  });

  if (!order) {
    return { ok: false as const, error: "Production order not found." };
  }

  const validation = await validateOrderDocumentUploads(files);
  if (!validation.ok) {
    return validation;
  }

  const maxDocuments = Number.parseInt(
    process.env.MAX_ORDER_DOCUMENTS ?? "10",
    10,
  );
  if (order._count.documents + validation.documents.length > maxDocuments) {
    return {
      ok: false as const,
      error: `This order already has ${order._count.documents} document(s). Maximum is ${maxDocuments}.`,
    };
  }

  const savedStorageKeys: string[] = [];
  const documentRows: Array<{
    shopId: string;
    productionOrderId: string;
    originalName: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];

  try {
    for (const document of validation.documents) {
      const { storageKey } = await saveOrderDocument({
        shopId,
        productionOrderId: orderId,
        file: document.file,
        extension: document.extension,
      });
      savedStorageKeys.push(storageKey);
      documentRows.push({
        shopId,
        productionOrderId: orderId,
        originalName: document.file.name.trim() || "document",
        storageKey,
        mimeType: document.mimeType,
        sizeBytes: document.file.size,
      });
    }

    await db.productionOrderDocument.createMany({ data: documentRows });

    await createAuditLog({
      shopId,
      action: "production_order.document_uploaded",
      entity: "ProductionOrder",
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        documentCount: documentRows.length,
      },
    });

    return { ok: true as const };
  } catch (error) {
    for (const storageKey of savedStorageKeys) {
      await deleteOrderDocument(storageKey).catch(() => undefined);
    }
    throw error;
  }
}

export async function deleteProductionOrderDocument({
  shopId,
  orderId,
  documentId,
}: {
  shopId: string;
  orderId: string;
  documentId: string;
}) {
  const document = await db.productionOrderDocument.findFirst({
    where: {
      id: documentId,
      shopId,
      productionOrderId: orderId,
    },
    include: {
      productionOrder: {
        select: { orderNumber: true },
      },
    },
  });

  if (!document) {
    return { ok: false as const, error: "Document not found." };
  }

  await db.productionOrderDocument.delete({ where: { id: document.id } });
  await deleteOrderDocument(document.storageKey).catch(() => undefined);

  await createAuditLog({
    shopId,
    action: "production_order.document_deleted",
    entity: "ProductionOrder",
    entityId: orderId,
    metadata: {
      orderNumber: document.productionOrder.orderNumber,
      documentId: document.id,
      originalName: document.originalName,
    },
  });

  return { ok: true as const };
}

export function collectDocumentFiles(formData: FormData): File[] {
  const files = formData
    .getAll("documents")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  return files;
}

export async function createProductionOrderFromParsedPdf({
  shopId,
  parsed,
  resolvedLines,
  pdfDocument,
}: {
  shopId: string;
  parsed: ParsedCircusOrderPdf;
  resolvedLines: ResolvedPdfImportLine[];
  pdfDocument: ValidatedOrderDocument;
}) {
  const orderDateResult = parseCalendarDate(parsed.orderDate);
  if (!orderDateResult.ok) {
    return { ok: false as const, error: "Order date is invalid." };
  }

  return createProductionOrderWithLines({
    shopId,
    orderData: {
      orderNumber: parsed.orderNumber,
      customerName: parsed.customerName,
      customerAddress: parsed.customerAddress,
      orderNote: null,
      orderDate: orderDateResult.date,
      dueDate: null,
      employee: null,
      status: "OPEN",
    },
    lines: resolvedLines,
    documents: [pdfDocument],
    auditMetadata: {
      importSource: "circus_order_pdf",
      parserVersion: CIRCUS_ORDER_PDF_PARSER_VERSION,
    },
  });
}
