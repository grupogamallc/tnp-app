/* POST /api/checkout
   Body: { producto, correo, nombre? }
   Devuelve: { url } — la pagina de pago alojada por Stripe.

   La tarjeta nunca pasa por nuestro codigo ni por nuestro dominio.
   No se pide crear cuenta antes de pagar: cada campo antes del pago cuesta
   conversion. La cuenta se crea sola cuando el pago se confirma. */
const L = require("./_lib");

module.exports = async (req, res) => {
  if (L.cors(req, res)) return;
  if (req.method !== "POST") { res.status(405).json({ error: "metodo" }); return; }

  try {
    const b = req.body || {};
    const correo = String(b.correo || "").trim().toLowerCase();
    const nombre = String(b.nombre || "").trim().slice(0, 80) || null;
    const productoId = String(b.producto || "").trim();

    if (!L.correoValido(correo)) { res.status(400).json({ error: "correo", mensaje: "Escribe un correo válido." }); return; }
    if (!/^[a-z0-9_]{2,40}$/.test(productoId)) { res.status(400).json({ error: "producto" }); return; }

    const prod = L.unaFila(await L.dbSel("productos",
      "select=id,nombre,tipo,precio_cents,recurrente,stripe_price,activo&id=eq." + encodeURIComponent(productoId)));
    if (!prod || !prod.activo) { res.status(404).json({ error: "no_existe", mensaje: "Ese plan no está disponible." }); return; }

    /* Sin precio configurado no se cobra mal: se dice claro y se para. */
    if (!prod.stripe_price) {
      res.status(503).json({ error: "sin_precio",
        mensaje: "Este plan todavía no tiene precio configurado. Escríbenos a info@tunuevoplan.com." });
      return;
    }

    /* El cliente de Stripe se busca por correo para no duplicarlo cuando la
       misma persona vuelve. */
    let cliente = await L.buscarCliente(correo);
    if (!cliente) {
      cliente = await L.stripe("/customers", {
        email: correo, name: nombre || undefined,
        metadata: { origen: "tnp", producto: productoId },
      });
    }

    const metadata = { producto: productoId, correo };
    const sesion = await L.stripe("/checkout/sessions", {
      mode: prod.recurrente ? "subscription" : "payment",
      customer: cliente.id,
      client_reference_id: correo,
      line_items: [{ price: prod.stripe_price, quantity: 1 }],
      success_url: L.APP_URL + "/?pago=ok&sid={CHECKOUT_SESSION_ID}",
      cancel_url: L.SITIO_URL + "/?pago=cancelado#programas",
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      /* Stripe Tax apagado: con registros fiscales en cero pide la direccion
         completa a cada comprador y cobra cero. Se prende al cruzar el umbral. */
      automatic_tax: { enabled: false },
      /* La metadata va dos veces: la de la sesion la lee checkout.session.completed
         y la de la suscripcion la leen los eventos customer.subscription.* */
      metadata,
      ...(prod.recurrente ? { subscription_data: { metadata } } : {}),
    });

    res.status(200).json({ url: sesion.url });
  } catch (e) {
    if (e.sinLlave) {
      res.status(503).json({ error: "sin_configurar",
        mensaje: "El cobro todavía no está activo. Escríbenos a info@tunuevoplan.com." });
      return;
    }
    /* El codigo de arriba (de Supabase o de Stripe) viaja de regreso: es un
       numero, no filtra nada, y sin el no hay forma de saber que fallo cuando
       los registros del servidor no estan a la mano. */
    console.error("checkout", e && e.status, e && e.message);
    res.status(500).json({ error: "servidor", codigo: (e && e.status) || null,
      pista: (e && e.message || "").slice(0, 90),
      mensaje: "No se pudo abrir el pago. Intenta otra vez." });
  }
};
