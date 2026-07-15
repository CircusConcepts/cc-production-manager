export const CIRCUS_ORDER_PDF_PARSER_VERSION = "1.0.0";

export const MAX_ORDER_PDF_PAGES = 50;

export type ParsedCircusOrderOption = {
  label: string;
  value: string;
};

export type ParsedCircusOrderLine = {
  pdfDescription: string;
  sku: string;
  model: string | null;
  quantity: number;
  unitPrice: string | null;
  lineTotal: string | null;
  options: ParsedCircusOrderOption[];
  colorName: string | null;
  size: string | null;
};

export type ParsedCircusOrderPdf = {
  orderNumber: string;
  orderDate: string;
  customerName: string;
  customerAddress: string;
  shippingMethod: string | null;
  lines: ParsedCircusOrderLine[];
  pageCount: number;
};

export type PdfTextItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageIndex: number;
};

export type PdfTextLine = {
  pageIndex: number;
  y: number;
  items: PdfTextItem[];
  text: string;
};

export type ParseResult =
  | { ok: true; data: ParsedCircusOrderPdf }
  | { ok: false; error: string };

type ColumnBounds = {
  product: { min: number; max: number };
  model: { min: number; max: number };
  quantity: { min: number; max: number };
  unitPrice: { min: number; max: number };
  total: { min: number; max: number };
};

const SUMMARY_LABELS = [
  "sub-total",
  "subtotal",
  "shipping",
  "insurance fee",
  "tax",
  "gst",
  "hst",
  "pst",
  "qst",
  "processing fee",
  "total",
] as const;

const NOISE_PATTERNS = [
  /^https?:\/\//i,
  /about:blank/i,
  /^\d{1,3}\s*\/\s*\d{1,3}$/,
  /^printed\b/i,
  /^generated\b/i,
];

export function normalizePdfText(value: string): string {
  const withoutControl = [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");

  return withoutControl
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .replace(/\u00ad/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeOrderNumberInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

export function groupTextItemsIntoLines(
  items: PdfTextItem[],
  yTolerance = 3,
): PdfTextLine[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (Math.abs(a.y - b.y) > yTolerance) return b.y - a.y;
    return a.x - b.x;
  });

  const lines: PdfTextLine[] = [];

  for (const item of sorted) {
    const normalized = normalizePdfText(item.text);
    if (!normalized) continue;

    const last = lines[lines.length - 1];
    if (
      last &&
      last.pageIndex === item.pageIndex &&
      Math.abs(last.y - item.y) <= yTolerance
    ) {
      last.items.push(item);
      last.text = normalizePdfText(
        `${last.text} ${normalized}`,
      );
      continue;
    }

    lines.push({
      pageIndex: item.pageIndex,
      y: item.y,
      items: [item],
      text: normalized,
    });
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = normalizePdfText(
      line.items.map((entry) => normalizePdfText(entry.text)).join(" "),
    );
  }

  return lines;
}

export function buildLinesFromLayout(
  rows: Array<{
    page?: number;
    y: number;
    segments: Array<{ text: string; x: number; width?: number }>;
  }>,
): PdfTextLine[] {
  const items: PdfTextItem[] = [];

  for (const row of rows) {
    const pageIndex = row.page ?? 0;
    for (const segment of row.segments) {
      const text = normalizePdfText(segment.text);
      if (!text) continue;
      items.push({
        text,
        x: segment.x,
        y: row.y,
        width: segment.width ?? text.length * 6,
        height: 10,
        pageIndex,
      });
    }
  }

  return groupTextItemsIntoLines(items);
}

function isNoiseLine(text: string): boolean {
  const normalized = normalizePdfText(text);
  if (!normalized) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function parseDateAdded(value: string): string | null {
  const match = value.match(/Date Added\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const monthText = String(month).padStart(2, "0");
  const dayText = String(day).padStart(2, "0");
  return `${year}-${monthText}-${dayText}`;
}

function findLabelItem(
  lines: PdfTextLine[],
  label: string,
): { line: PdfTextLine; item: PdfTextItem } | null {
  const target = label.toLowerCase();

  for (const line of lines) {
    for (const item of line.items) {
      if (normalizePdfText(item.text).toLowerCase() === target) {
        return { line, item };
      }
    }

    if (line.text.toLowerCase().includes(target)) {
      const item =
        line.items.find((entry) =>
          normalizePdfText(entry.text).toLowerCase().includes(target),
        ) ?? line.items[0];
      if (item) return { line, item };
    }
  }

  return null;
}

function findLineIndexContaining(lines: PdfTextLine[], needle: string): number {
  const target = needle.toLowerCase();
  return lines.findIndex((line) => line.text.toLowerCase().includes(target));
}

function itemCenter(item: PdfTextItem): number {
  return item.x + item.width / 2;
}

function assignItemsToColumn(
  items: PdfTextItem[],
  bounds: ColumnBounds,
  column: keyof ColumnBounds,
): string {
  const range = bounds[column];
  const parts = items
    .filter((item) => {
      const center = itemCenter(item);
      return center >= range.min && center <= range.max;
    })
    .sort((a, b) => a.x - b.x)
    .map((item) => normalizePdfText(item.text))
    .filter(Boolean);

  return normalizePdfText(parts.join(" "));
}

function buildColumnBounds(headerLine: PdfTextLine): ColumnBounds | null {
  const labels: Array<{ key: keyof ColumnBounds; text: string }> = [
    { key: "product", text: "product" },
    { key: "model", text: "model" },
    { key: "quantity", text: "quantity" },
    { key: "unitPrice", text: "unit price" },
    { key: "total", text: "total" },
  ];

  const anchors: Partial<Record<keyof ColumnBounds, number>> = {};

  for (const label of labels) {
    const item = headerLine.items.find((entry) =>
      normalizePdfText(entry.text).toLowerCase().includes(label.text),
    );
    if (!item) return null;
    anchors[label.key] = item.x;
  }

  const ordered = labels
    .map((label) => ({
      key: label.key,
      x: anchors[label.key] as number,
    }))
    .sort((a, b) => a.x - b.x);

  const bounds = {} as ColumnBounds;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const min = current.x - 2;
    const max = next ? (current.x + next.x) / 2 : current.x + 500;
    bounds[current.key] = { min, max };
  }

  return bounds;
}

function isSummaryLine(text: string): boolean {
  const normalized = normalizePdfText(text).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("unit price")) return false;

  return SUMMARY_LABELS.some((label) => {
    if (label === "total") {
      return normalized === "total" || normalized.startsWith("total ");
    }
    if (label === "shipping") {
      return (
        normalized.includes("shipping charge") ||
        normalized.startsWith("shipping ")
      );
    }
    return normalized.includes(label);
  });
}

function isTableHeaderLine(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("product") &&
    normalized.includes("quantity") &&
    normalized.includes("total")
  );
}

function extractSkuFromDescription(
  description: string,
): { ok: true; sku: string } | { ok: false; error: string } {
  const compact = description.replace(/\s+/g, " ");
  const matches = [...compact.matchAll(/\(\s*SKU\s*:\s*([^)]+)\)/gi)];

  if (matches.length === 0) {
    return { ok: false, error: "A product line is missing its SKU." };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "A product line contains multiple SKU values.",
    };
  }

  const sku = matches[0][1].replace(/\s+/g, "");
  if (!sku) {
    return { ok: false, error: "A product line has an empty SKU." };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku)) {
    return { ok: false, error: "A product line contains a malformed SKU." };
  }

  return { ok: true, sku };
}

function parseOptionsFromDescription(description: string): {
  options: ParsedCircusOrderOption[];
  colorName: string | null;
  size: string | null;
} {
  const options: ParsedCircusOrderOption[] = [];
  let colorName: string | null = null;
  let size: string | null = null;

  const lines = description
    .split(/\n+/)
    .map((line) => normalizePdfText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (/^\(\s*SKU\s*:/i.test(line)) continue;

    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;

    const label = normalizePdfText(match[1]);
    const value = normalizePdfText(match[2]);
    if (!label || !value) continue;

    if (label === "Color" || label === "Colour") {
      if (colorName) {
        continue;
      }
      colorName = value;
      continue;
    }

    if (label === "Size") {
      if (size) {
        continue;
      }
      size = value;
      continue;
    }

    options.push({ label, value });
  }

  return { options, colorName, size };
}

function parseQuantity(value: string): number | null {
  const normalized = normalizePdfText(value);
  if (!normalized) return null;
  if (!/^\d+$/.test(normalized)) return null;
  const quantity = Number.parseInt(normalized, 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) {
    return null;
  }
  return quantity;
}

function hasUpcomingQuantityRows(
  lines: PdfTextLine[],
  fromIndex: number,
  bounds: ColumnBounds,
): boolean {
  for (let index = fromIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (isTableHeaderLine(line.text)) continue;
    const quantity = parseQuantity(
      assignItemsToColumn(line.items, bounds, "quantity"),
    );
    if (quantity !== null) {
      return true;
    }
  }
  return false;
}

function parseProductRows(
  lines: PdfTextLine[],
  bounds: ColumnBounds,
): { ok: true; lines: ParsedCircusOrderLine[] } | { ok: false; error: string } {
  const parsedLines: ParsedCircusOrderLine[] = [];
  let current:
    | {
        productParts: string[];
        model: string | null;
        quantity: number;
        unitPrice: string | null;
        lineTotal: string | null;
      }
    | null = null;

  const flushCurrent = () => {
    if (!current) return;

    const pdfDescription = current.productParts
      .map((part) => normalizePdfText(part))
      .filter(Boolean)
      .join("\n");

    const skuResult = extractSkuFromDescription(pdfDescription);
    if (!skuResult.ok) {
      throw new Error(skuResult.error);
    }

    const optionResult = parseOptionsFromDescription(pdfDescription);

    parsedLines.push({
      pdfDescription,
      sku: skuResult.sku,
      model: current.model,
      quantity: current.quantity,
      unitPrice: current.unitPrice,
      lineTotal: current.lineTotal,
      options: optionResult.options,
      colorName: optionResult.colorName,
      size: optionResult.size,
    });
    current = null;
  };

  try {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (isNoiseLine(line.text)) continue;
      if (isTableHeaderLine(line.text)) continue;
      if (isSummaryLine(line.text)) {
        flushCurrent();
        if (!hasUpcomingQuantityRows(lines, lineIndex, bounds)) {
          break;
        }
        continue;
      }

      const quantityText = assignItemsToColumn(line.items, bounds, "quantity");
      const quantity = parseQuantity(quantityText);
      const productText = assignItemsToColumn(line.items, bounds, "product");
      const modelText = assignItemsToColumn(line.items, bounds, "model");
      const unitPrice = assignItemsToColumn(line.items, bounds, "unitPrice");
      const lineTotal = assignItemsToColumn(line.items, bounds, "total");

      if (quantity !== null) {
        flushCurrent();
        if (!productText) {
          return {
            ok: false,
            error: "A product row is missing its product description.",
          };
        }

        current = {
          productParts: [productText],
          model: modelText || null,
          quantity,
          unitPrice: unitPrice || null,
          lineTotal: lineTotal || null,
        };
        continue;
      }

      if (current && productText && !quantityText && !modelText) {
        current.productParts.push(productText);
        continue;
      }

      if (productText || modelText || quantityText || unitPrice || lineTotal) {
        return {
          ok: false,
          error: "A product table row could not be interpreted unambiguously.",
        };
      }
    }

    flushCurrent();
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The product table could not be parsed.",
    };
  }

  if (parsedLines.length === 0) {
    return { ok: false, error: "No product lines were found in the PDF." };
  }

  return { ok: true, lines: parsedLines };
}

function parseShippingAddress(
  lines: PdfTextLine[],
): { ok: true; customerName: string; customerAddress: string } | { ok: false; error: string } {
  const paymentLabel = findLabelItem(lines, "Payment Address");
  const shippingLabel = findLabelItem(lines, "Shipping Address");

  if (!shippingLabel) {
    return { ok: false, error: "Shipping Address was not found in the PDF." };
  }
  if (!paymentLabel) {
    return {
      ok: false,
      error: "Payment Address and Shipping Address could not be distinguished.",
    };
  }

  const divider = (paymentLabel.item.x + shippingLabel.item.x) / 2;
  if (Math.abs(shippingLabel.item.x - paymentLabel.item.x) < 40) {
    return {
      ok: false,
      error: "Payment Address and Shipping Address could not be distinguished.",
    };
  }

  const tableStartIndex = findLineIndexContaining(lines, "Product");
  const startIndex = lines.findIndex(
    (line) =>
      line.pageIndex === shippingLabel.line.pageIndex &&
      Math.abs(line.y - shippingLabel.line.y) < 0.01,
  );
  const endIndex = tableStartIndex >= 0 ? tableStartIndex : lines.length;

  const shippingLines: string[] = [];

  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const line = lines[index];
    if (isNoiseLine(line.text)) continue;
    if (isTableHeaderLine(line.text)) break;
    if (line.text.toLowerCase().includes("payment address")) continue;
    if (line.text.toLowerCase().includes("shipping address")) continue;

    const shippingParts = line.items
      .filter((item) => itemCenter(item) >= divider)
      .sort((a, b) => a.x - b.x)
      .map((item) => normalizePdfText(item.text))
      .filter(Boolean);

    const paymentParts = line.items
      .filter((item) => itemCenter(item) < divider)
      .map((item) => normalizePdfText(item.text))
      .filter(Boolean);

    if (shippingParts.length === 0 && paymentParts.length > 0) {
      continue;
    }

    if (shippingParts.length === 0) {
      continue;
    }

    shippingLines.push(normalizePdfText(shippingParts.join(" ")));
  }

  const cleaned = shippingLines.map((line) => normalizePdfText(line)).filter(Boolean);
  if (cleaned.length === 0) {
    return { ok: false, error: "Shipping Address is empty in the PDF." };
  }

  const customerName = cleaned[0];
  const customerAddress = cleaned.slice(1).join("\n");

  if (!customerName) {
    return { ok: false, error: "Customer name is missing from Shipping Address." };
  }
  if (!customerAddress) {
    return { ok: false, error: "Customer address is missing from Shipping Address." };
  }

  return { ok: true, customerName, customerAddress };
}

function parseShippingMethod(lines: PdfTextLine[]): string | null {
  for (const line of lines) {
    const match = line.text.match(/Shipping Method\s*:\s*(.+)$/i);
    if (match) {
      return normalizePdfText(match[1]);
    }
  }
  return null;
}

export function parseCircusOrderFromTextLines(
  lines: PdfTextLine[],
  options: {
    manualOrderNumber?: string;
    pageCount?: number;
  } = {},
): ParseResult {
  const usableLines = lines.filter((line) => !isNoiseLine(line.text));
  if (usableLines.length === 0) {
    return { ok: false, error: "The PDF does not contain a readable text layer." };
  }

  const orderHeaderMatch = usableLines
    .map((line) => line.text.match(/ORDER\s*\(#\s*([^)]+)\)/i))
    .find(Boolean);
  const orderIdLine = usableLines.find((line) => /Order ID\s*:/i.test(line.text));
  const dateLine = usableLines.find((line) => /Date Added/i.test(line.text));

  if (!orderHeaderMatch) {
    return { ok: false, error: "ORDER (#...) was not found in the PDF." };
  }
  if (!orderIdLine) {
    return { ok: false, error: "Order ID was not found in the PDF." };
  }
  if (!dateLine) {
    return { ok: false, error: "Date Added was not found in the PDF." };
  }

  const headerOrderNumber = normalizeOrderNumberInput(orderHeaderMatch[1]);
  const orderIdMatch = orderIdLine.text.match(/Order ID\s*:\s*([^\s]+)/i);
  if (!orderIdMatch) {
    return { ok: false, error: "Order ID could not be parsed from the PDF." };
  }
  const pdfOrderId = normalizeOrderNumberInput(orderIdMatch[1]);

  if (!headerOrderNumber || !pdfOrderId) {
    return { ok: false, error: "Order number is missing from the PDF." };
  }
  if (headerOrderNumber !== pdfOrderId) {
    return {
      ok: false,
      error: "ORDER (#...) and Order ID do not match in the PDF.",
    };
  }

  if (options.manualOrderNumber !== undefined) {
    const manual = normalizeOrderNumberInput(options.manualOrderNumber);
    if (!manual) {
      return { ok: false, error: "Order number is required." };
    }
    if (manual !== headerOrderNumber) {
      return {
        ok: false,
        error: "The entered order number does not match the PDF.",
      };
    }
  }

  const orderDate = parseDateAdded(dateLine.text);
  if (!orderDate) {
    return { ok: false, error: "Date Added is missing or invalid in the PDF." };
  }

  const addressResult = parseShippingAddress(usableLines);
  if (!addressResult.ok) {
    return addressResult;
  }

  const tableHeaderIndex = usableLines.findIndex((line) =>
    isTableHeaderLine(line.text),
  );
  if (tableHeaderIndex < 0) {
    return { ok: false, error: "Product table headers were not found in the PDF." };
  }

  const bounds = buildColumnBounds(usableLines[tableHeaderIndex]);
  if (!bounds) {
    return {
      ok: false,
      error: "Product table columns could not be identified in the PDF.",
    };
  }

  const tableLines: PdfTextLine[] = [];
  for (let index = tableHeaderIndex; index < usableLines.length; index += 1) {
    const line = usableLines[index];
    if (index !== tableHeaderIndex && isTableHeaderLine(line.text)) {
      continue;
    }
    tableLines.push(line);
  }

  const productResult = parseProductRows(tableLines, bounds);
  if (!productResult.ok) {
    return productResult;
  }

  return {
    ok: true,
    data: {
      orderNumber: headerOrderNumber,
      orderDate,
      customerName: addressResult.customerName,
      customerAddress: addressResult.customerAddress,
      shippingMethod: parseShippingMethod(usableLines),
      lines: productResult.lines,
      pageCount: options.pageCount ?? 1,
    },
  };
}

export function hasUsablePdfTextLayer(lines: PdfTextLine[]): boolean {
  const meaningful = lines
    .map((line) => normalizePdfText(line.text))
    .filter((text) => text.length > 0);
  return meaningful.length > 0;
}
