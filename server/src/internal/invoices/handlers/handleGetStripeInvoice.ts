import { ErrCode, RecaseError, Scopes } from "@autumn/shared";
import type Stripe from "stripe";
import { createStripeCli } from "@/external/connect/createStripeCli.js";
import { createRoute } from "@/honoMiddlewares/routeHandler.js";

const STRIPE_INVOICE_ID_PREFIX = "in_";
// Stripe invoice numbers are a customer prefix plus a sequence, e.g. ABCD1234-0003.
// Restricting the charset keeps the value safe to embed in a search query.
const STRIPE_INVOICE_NUMBER_REGEX = /^[A-Za-z0-9-]+$/;

/** Stripe invoice numbers (as printed on the invoice) are not stored in Autumn,
 * so resolve one to its in_... ID through Stripe search. */
const stripeInvoiceIdFromNumber = async ({
	stripeCli,
	invoiceNumber,
}: {
	stripeCli: Stripe;
	invoiceNumber: string;
}) => {
	if (!STRIPE_INVOICE_NUMBER_REGEX.test(invoiceNumber)) {
		throw new RecaseError({
			message: `${invoiceNumber} is neither a Stripe invoice ID (in_...) nor an invoice number`,
			code: ErrCode.InvalidRequest,
			statusCode: 400,
		});
	}

	const { data } = await stripeCli.invoices.search({
		query: `number:"${invoiceNumber}"`,
		limit: 1,
	});
	const [match] = data;
	if (!match?.id) {
		throw new RecaseError({
			message: `No Stripe invoice with number ${invoiceNumber}. Invoices created in the last minute may not be searchable yet.`,
			code: ErrCode.InvoiceNotFound,
			statusCode: 404,
		});
	}
	return match.id;
};

/**
 * Get a Stripe invoice by its Stripe ID (in_...) or its invoice number
 * (e.g. ABCD1234-0003). Requires authentication via secret key middleware.
 */
export const handleGetStripeInvoice = createRoute({
	scopes: [Scopes.Billing.Read],
	handler: async (c) => {
		const { org, env } = c.get("ctx");
		const { stripe_invoice_id: invoiceIdOrNumber } = c.req.param();

		const stripeCli = createStripeCli({
			org,
			env,
		});

		const stripeInvoiceId = invoiceIdOrNumber.startsWith(
			STRIPE_INVOICE_ID_PREFIX,
		)
			? invoiceIdOrNumber
			: await stripeInvoiceIdFromNumber({
					stripeCli,
					invoiceNumber: invoiceIdOrNumber,
				});

		// The customer is expanded so callers can edit the live record, not the
		// snapshot the invoice took at finalization. Payment intents carry the
		// last_payment_error that explains why an open invoice is unpaid.
		const stripeInvoice = await stripeCli.invoices.retrieve(stripeInvoiceId, {
			expand: ["customer.tax_ids", "payments.data.payment.payment_intent"],
		});

		return c.json(stripeInvoice);
	},
});
