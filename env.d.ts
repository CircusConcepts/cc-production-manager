/// <reference types="vite/client" />
/// <reference types="@react-router/node" />
/// <reference types="@prisma/client" />

declare module "*.jpg" {
  const src: string;
  export default src;
}
