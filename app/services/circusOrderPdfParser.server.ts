import {
  groupTextItemsIntoLines,
  hasUsablePdfTextLayer,
  MAX_ORDER_PDF_PAGES,
  parseCircusOrderFromTextLines,
  type ParseResult,
  type PdfTextItem,
} from "./circusOrderPdfParser.core";

export {
  CIRCUS_ORDER_PDF_PARSER_VERSION,
  buildLinesFromLayout,
  groupTextItemsIntoLines,
  normalizeOrderNumberInput,
  normalizePdfText,
  parseCircusOrderFromTextLines,
  type ParsedCircusOrderLine,
  type ParsedCircusOrderOption,
  type ParsedCircusOrderPdf,
  type ParseResult,
  type PdfTextItem,
  type PdfTextLine,
} from "./circusOrderPdfParser.core";

type PdfJsTextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
};

type PdfJsModule = {
  getDocument: (options: {
    data: Uint8Array;
    disableFontFace?: boolean;
    useSystemFonts?: boolean;
  }) => {
    promise: Promise<{
      numPages: number;
      getPage: (pageNumber: number) => Promise<{
        getTextContent: (options?: {
          includeMarkedContent?: boolean;
          disableNormalization?: boolean;
        }) => Promise<{ items: unknown[] }>;
      }>;
    }>;
  };
};

async function loadPdfJs(): Promise<PdfJsModule> {
  // Load at runtime so Vite SSR does not bundle the deep package entry.
  try {
    return (await import(
      /* @vite-ignore */
      "pdfjs-dist/legacy/build/pdf.mjs"
    )) as PdfJsModule;
  } catch {
    return (await import(
      /* @vite-ignore */
      "pdfjs-dist/build/pdf.mjs"
    )) as PdfJsModule;
  }
}

function isPdfJsTextItem(value: unknown): value is PdfJsTextItem {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    "transform" in value &&
    Array.isArray((value as PdfJsTextItem).transform)
  );
}

function toUint8Array(data: Buffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

function mapTextItem(
  item: PdfJsTextItem,
  pageIndex: number,
): PdfTextItem | null {
  const text = String(item.str ?? "");
  if (!text.trim()) return null;

  const transform = item.transform;
  const x = transform[4];
  const y = transform[5];
  const width = item.width ?? text.length * 6;
  const height = item.height ?? 10;

  return {
    text,
    x,
    y,
    width,
    height,
    pageIndex,
  };
}

export async function extractPdfTextItems(
  data: Buffer | Uint8Array,
): Promise<
  | {
      ok: true;
      items: PdfTextItem[];
      pageCount: number;
    }
  | { ok: false; error: string }
> {
  let pdf;
  try {
    const { getDocument } = await loadPdfJs();
    const loadingTask = getDocument({
      data: toUint8Array(data),
      disableFontFace: true,
      useSystemFonts: true,
    });
    pdf = await loadingTask.promise;
  } catch {
    return { ok: false, error: "The PDF file could not be opened." };
  }

  const pageCount = pdf.numPages;
  if (pageCount < 1) {
    return { ok: false, error: "The PDF file is empty." };
  }
  if (pageCount > MAX_ORDER_PDF_PAGES) {
    return {
      ok: false,
      error: `The PDF exceeds the ${MAX_ORDER_PDF_PAGES}-page limit.`,
    };
  }

  const items: PdfTextItem[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      });

      for (const rawItem of textContent.items) {
        if (!isPdfJsTextItem(rawItem)) continue;
        const mapped = mapTextItem(rawItem, pageNumber - 1);
        if (mapped) {
          items.push(mapped);
        }
      }
    }
  } catch {
    return {
      ok: false,
      error: "Password-protected PDFs are not supported.",
    };
  }

  return { ok: true, items, pageCount };
}

export async function parseCircusOrderPdf(
  data: Buffer | Uint8Array,
  manualOrderNumber: string,
): Promise<ParseResult> {
  const extraction = await extractPdfTextItems(data);
  if (!extraction.ok) {
    return extraction;
  }

  const lines = groupTextItemsIntoLines(extraction.items);
  if (!hasUsablePdfTextLayer(lines)) {
    return {
      ok: false,
      error: "The PDF does not contain a readable text layer.",
    };
  }

  return parseCircusOrderFromTextLines(lines, {
    manualOrderNumber,
    pageCount: extraction.pageCount,
  });
}
