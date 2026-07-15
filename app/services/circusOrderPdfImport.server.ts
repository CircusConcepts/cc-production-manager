import {
  getMaxOrderDocumentBytes,
  type ValidatedOrderDocument,
} from "./orderDocumentStorage.server";
import {
  CIRCUS_ORDER_PDF_PARSER_VERSION,
  parseCircusOrderPdf,
  type ParsedCircusOrderPdf,
} from "./circusOrderPdfParser.server";
import {
  checkDuplicateProductionOrderNumber,
  createProductionOrderFromParsedPdf,
  resolveParsedPdfLinesForShop,
  type ResolvedPdfImportLine,
} from "./productionOrder.server";

export type OrderPdfPreviewLine = {
  sku: string;
  productName: string;
  quantity: number;
  colorName: string | null;
  size: string | null;
  options: Array<{ label: string; value: string }>;
  pdfDescription: string;
};

export type OrderPdfPreview = {
  orderNumber: string;
  orderDate: string;
  customerName: string;
  customerAddress: string;
  shippingMethod: string | null;
  pdfFilename: string;
  lines: OrderPdfPreviewLine[];
  parserVersion: string;
};

export type OrderPdfPreviewResult =
  | { ok: true; preview: OrderPdfPreview }
  | { ok: false; error: string };

export async function validateOrderPdfUpload(
  file: unknown,
): Promise<
  | { ok: true; file: File; buffer: Buffer }
  | { ok: false; error: string }
> {
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "A PDF order file is required." };
  }

  const maxBytes = getMaxOrderDocumentBytes();
  if (file.size > maxBytes) {
    return { ok: false, error: "The PDF must be 10 MB or smaller." };
  }

  const filename = file.name.trim().toLowerCase();
  if (!filename.endsWith(".pdf")) {
    return { ok: false, error: "Only PDF files are accepted." };
  }

  if (file.type && file.type !== "application/pdf") {
    return { ok: false, error: "Only PDF files are accepted." };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return { ok: false, error: "The uploaded file is not a valid PDF." };
  }

  return { ok: true, file, buffer };
}

function buildPreview(
  parsed: ParsedCircusOrderPdf,
  resolvedLines: ResolvedPdfImportLine[],
  pdfFilename: string,
): OrderPdfPreview {
  return {
    orderNumber: parsed.orderNumber,
    orderDate: parsed.orderDate,
    customerName: parsed.customerName,
    customerAddress: parsed.customerAddress,
    shippingMethod: parsed.shippingMethod,
    pdfFilename,
    parserVersion: CIRCUS_ORDER_PDF_PARSER_VERSION,
    lines: resolvedLines.map((line) => ({
      sku: line.sku,
      productName: line.productName,
      quantity: line.quantity,
      colorName: line.colorName,
      size: line.size,
      options: line.options,
      pdfDescription: line.pdfDescription,
    })),
  };
}

export async function previewOrderPdfImport({
  shopId,
  manualOrderNumber,
  pdfFile,
}: {
  shopId: string;
  manualOrderNumber: string;
  pdfFile: File;
}): Promise<OrderPdfPreviewResult> {
  const validation = await validateOrderPdfUpload(pdfFile);
  if (!validation.ok) {
    return validation;
  }

  const parsed = await parseCircusOrderPdf(
    validation.buffer,
    manualOrderNumber,
  );
  if (!parsed.ok) {
    return parsed;
  }

  const duplicate = await checkDuplicateProductionOrderNumber(
    shopId,
    parsed.data.orderNumber,
  );
  if (duplicate) {
    return duplicate;
  }

  const resolved = await resolveParsedPdfLinesForShop({
    shopId,
    lines: parsed.data.lines,
  });
  if (!resolved.ok) {
    return resolved;
  }

  return {
    ok: true,
    preview: buildPreview(
      parsed.data,
      resolved.lines,
      pdfFile.name.trim() || "order.pdf",
    ),
  };
}

export async function createOrderPdfImport({
  shopId,
  manualOrderNumber,
  pdfFile,
}: {
  shopId: string;
  manualOrderNumber: string;
  pdfFile: File;
}) {
  const validation = await validateOrderPdfUpload(pdfFile);
  if (!validation.ok) {
    return validation;
  }

  const parsed = await parseCircusOrderPdf(
    validation.buffer,
    manualOrderNumber,
  );
  if (!parsed.ok) {
    return parsed;
  }

  const duplicate = await checkDuplicateProductionOrderNumber(
    shopId,
    parsed.data.orderNumber,
  );
  if (duplicate) {
    return duplicate;
  }

  const resolved = await resolveParsedPdfLinesForShop({
    shopId,
    lines: parsed.data.lines,
  });
  if (!resolved.ok) {
    return resolved;
  }

  const pdfDocument: ValidatedOrderDocument = {
    file: pdfFile,
    mimeType: "application/pdf",
    extension: ".pdf",
  };

  return createProductionOrderFromParsedPdf({
    shopId,
    parsed: parsed.data,
    resolvedLines: resolved.lines,
    pdfDocument,
  });
}

export function readOrderPdfFromFormData(
  formData: FormData,
): File | null {
  const file = formData.get("orderPdf");
  return file instanceof File && file.size > 0 ? file : null;
}
