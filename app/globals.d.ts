declare module "*.css";

declare module "pdfjs-dist/legacy/build/pdf.mjs";
declare module "pdfjs-dist/build/pdf.mjs";

declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    >;
  }
}
