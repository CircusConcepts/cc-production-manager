import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>CircusConcepts Production Manager</h1>
        <p className={styles.text}>
          Internal production, stock, and order management for CircusConcepts.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Serialized inventory</strong>. Track individual physical
            items by serial number.
          </li>
          <li>
            <strong>Stock tracking</strong>. Count in-stock items from
            serialized inventory — no stored quantity fields.
          </li>
          <li>
            <strong>Read-only toward Shopify</strong>. Production data is stored
            in this app database.
          </li>
        </ul>
      </div>
    </div>
  );
}
