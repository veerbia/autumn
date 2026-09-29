/**
 * Looking up one invoice by its Stripe ID.
 *
 * Contract:
 *   invoices.list { stripe_id }             → only that invoice (with or without customer_id)
 *   invoices.list { stripe_id: unknown }    → empty list
 *   invoices.list { invoice_id }            → only that invoice
 *   GET /invoices/:stripe_id/stripe         → payments expanded to their payment intents
 */

import { expect, test } from "bun:test";
import { type ApiListInvoiceV1, invoices } from "@autumn/shared";
import { items } from "@tests/utils/fixtures/items";
import { products } from "@tests/utils/fixtures/products";
import ctx from "@tests/utils/testInitUtils/createTestContext";
import { initScenario, s } from "@tests/utils/testInitUtils/initScenario";
import chalk from "chalk";
import type Stripe from "stripe";

test.concurrent(
	`${chalk.yellowBright("invoices.list: stripe_id filter + Stripe route expands payment intents")}`,
	async () => {
		const customerId = "inv-list-stripe-id";
		const pro = products.pro({
			id: "pro-list-stripe-id",
			items: [items.monthlyMessages({ includedUsage: 100 })],
		});
		const { autumnV2_3 } = await initScenario({
			customerId,
			setup: [
				s.customer({ paymentMethod: "success" }),
				s.products({ list: [pro] }),
			],
			actions: [s.billing.attach({ productId: pro.id })],
		});

		const { list: attachInvoices } = (await autumnV2_3.post("/invoices.list", {
			customer_id: customerId,
		})) as { list: ApiListInvoiceV1[] };
		expect(attachInvoices).toHaveLength(1);
		const [attachInvoice] = attachInvoices;

		// A second invoice for the same customer that the filter must exclude.
		const customerRow = await ctx.db.query.customers.findFirst({
			where: (customer, { and, eq }) =>
				and(
					eq(customer.org_id, ctx.org.id),
					eq(customer.env, ctx.env),
					eq(customer.id, customerId),
				),
		});
		const seededStripeId = `in_seeded_${Date.now()}`;
		await ctx.db.insert(invoices).values({
			id: `inv_seeded_${Date.now()}`,
			internal_customer_id: customerRow!.internal_id,
			stripe_id: seededStripeId,
			status: "open",
			total: 1,
			currency: "usd",
		});

		const byCustomerAndStripeId = (await autumnV2_3.post("/invoices.list", {
			customer_id: customerId,
			stripe_id: attachInvoice.stripe_id,
		})) as { list: ApiListInvoiceV1[] };
		expect(
			byCustomerAndStripeId.list.map((invoice) => invoice.stripe_id),
		).toEqual([attachInvoice.stripe_id]);

		const byStripeIdOnly = (await autumnV2_3.post("/invoices.list", {
			stripe_id: seededStripeId,
		})) as { list: ApiListInvoiceV1[] };
		expect(byStripeIdOnly.list).toHaveLength(1);
		expect(byStripeIdOnly.list[0].customer_id).toBe(customerId);
		expect(byStripeIdOnly.list[0].status).toBe("open");

		const byUnknownStripeId = (await autumnV2_3.post("/invoices.list", {
			stripe_id: "in_does_not_exist",
		})) as { list: ApiListInvoiceV1[] };
		expect(byUnknownStripeId.list).toHaveLength(0);

		const byInvoiceId = (await autumnV2_3.post("/invoices.list", {
			invoice_id: attachInvoice.id,
		})) as { list: ApiListInvoiceV1[] };
		expect(byInvoiceId.list.map((invoice) => invoice.id)).toEqual([
			attachInvoice.id,
		]);

		const stripeInvoice = (await autumnV2_3.get(
			`/invoices/${attachInvoice.stripe_id}/stripe`,
		)) as Stripe.Invoice;
		const paymentIntent =
			stripeInvoice.payments?.data[0]?.payment?.payment_intent;
		expect(typeof paymentIntent).toBe("object");
		expect((paymentIntent as Stripe.PaymentIntent).status).toBe("succeeded");
	},
);

// Stripe search indexes new invoices with a delay of up to about a minute.
const SEARCH_INDEX_TIMEOUT_MS = 120_000;
const SEARCH_POLL_INTERVAL_MS = 5_000;

test.concurrent(
	`${chalk.yellowBright("GET /invoices/:number/stripe: looks a Stripe invoice up by its number")}`,
	async () => {
		const customerId = "inv-stripe-by-number";
		const pro = products.pro({
			id: "pro-stripe-by-number",
			items: [items.monthlyMessages({ includedUsage: 100 })],
		});
		const { autumnV2_3 } = await initScenario({
			customerId,
			setup: [
				s.customer({ paymentMethod: "success" }),
				s.products({ list: [pro] }),
			],
			actions: [s.billing.attach({ productId: pro.id })],
		});

		const {
			list: [invoice],
		} = (await autumnV2_3.post("/invoices.list", {
			customer_id: customerId,
		})) as { list: ApiListInvoiceV1[] };
		const byId = (await autumnV2_3.get(
			`/invoices/${invoice.stripe_id}/stripe`,
		)) as Stripe.Invoice;
		expect(byId.number).toBeTruthy();

		const deadline = Date.now() + SEARCH_INDEX_TIMEOUT_MS;
		let byNumber: Stripe.Invoice | null = null;
		while (!byNumber) {
			try {
				byNumber = (await autumnV2_3.get(
					`/invoices/${byId.number}/stripe`,
				)) as Stripe.Invoice;
			} catch (error) {
				if (Date.now() > deadline) throw error;
				await new Promise((resolve) =>
					setTimeout(resolve, SEARCH_POLL_INTERVAL_MS),
				);
			}
		}
		expect(byNumber.id).toBe(invoice.stripe_id);
		expect(typeof byNumber.payments?.data[0]?.payment?.payment_intent).toBe(
			"object",
		);

		await expect(
			autumnV2_3.get("/invoices/ZZZZZZZZ-9999/stripe"),
		).rejects.toThrow();
		await expect(
			autumnV2_3.get(`/invoices/${encodeURIComponent('x" OR 1')}/stripe`),
		).rejects.toThrow();
	},
);
