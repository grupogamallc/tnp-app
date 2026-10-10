/* POST /api/webhook  — el aviso firmado de Stripe.

   Esta es la UNICA fuente de verdad del acceso. El regreso del navegador a la
   pagina de gracias NO prueba que alguien pago: cualquiera puede escribir esa
   direccion. Solo lo que llega firmado aqui activa o desactiva una membresia.

   En Vercel hay que apagar el parseo del cuerpo: la firma se calcula sobre el
   cuerpo CRUDO y un JSON.parse previo la rompe. */
const L = require("./_lib");

module.exports.config = { api: { bodyParser: false } };

async function yaProcesado(id) {
  const r = await L.dbSel("stripe_eventos", "select=id&id=eq." + encodeURIComponent(id) + "&limit=1");
  return !!(r && r.length);
}
async function marcar(id, tipo) {
  await L.dbIns("stripe_eventos", [{ id, tipo, recibido: new Date().toISOString() }]).catch(() => {});
}

/* La suscripcion del plan principal de esa persona */
async function porSuscripcion(subId) {
  if (!subId) return null;
  return L.unaFila(await L.dbSel("membresias",
    "select=perfil_id,nivel&stripe_subscription=eq." + encodeURIComponent(subId) + "&limit=1"));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).end(); return; }

  let crudo;
  try { crudo = await L.cuerpoCrudo(req); }
  catch (e) { res.status(400).json({ error: "cuerpo" }); return; }

  const secreto = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secreto) { console.error("webhook sin STRIPE_WEBHOOK_SECRET"); res.status(503).end(); return; }

  if (!L.verificarFirma(crudo, req.headers["stripe-signature"], secreto)) {
    res.status(400).json({ error: "firma_invalida" }); return;
  }

  let ev;
  try { ev = JSON.parse(crudo); } catch (e) { res.status(400).json({ error: "json" }); return; }

  try {
    if (await yaProcesado(ev.id)) { res.status(200).json({ ok: true, repetido: true }); return; }

    const o = ev.data && ev.data.object;

    switch (ev.type) {

      /* El pago inicial. Nunca las renovaciones.
         Van juntos a proposito: con metodos de pago asincronos (transferencia,
         debito bancario) la sesion se marca "complete" PERO el dinero todavia no
         llega. En ese caso completed trae payment_status "unpaid" y el dinero se
         confirma despues con async_payment_succeeded. Dar acceso con la sesion
         completa pero sin pagar es regalar el producto. */
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const pagado = o.payment_status === "paid" || o.payment_status === "no_payment_required";
        if (!pagado) break;
        const r = await L.activarCompra({ sesion: o });
        /* El correo de acceso: Stripe manda el recibo, pero no puede mandar la
           llave del producto. Va fuera del camino critico — si falla, el acceso
           ya quedo dado y la persona puede entrar pidiendo otra liga. */
        try {
          const liga = await L.ligaDeEntrada(r.correo, "magiclink");
          await L.correo(r.correo, "Tu plan está listo",
            L.plantilla("Ya tienes acceso.",
              ["Tu pago quedó confirmado y tu cuenta está abierta.",
               "Toca el botón para entrar. Te vamos a pedir que crees una contraseña, para que la próxima vez entres directo."],
              "Entrar a mi plan", liga),
            "Ya tienes acceso. Entra aquí: " + liga);
        } catch (e) { console.error("correo de bienvenida", e && e.message); }
        break;
      }

      /* Renovacion cobrada: se mueve la fecha de acceso. */
      case "invoice.paid": {
        /* El id de la suscripcion NO se saca de o.subscription: ese campo ya no
           existe en el API nuevo. L.subDeFactura sabe donde esta. */
        const subId = L.subDeFactura(o);
        const m = await porSuscripcion(subId);
        if (!m) break;
        const sub = subId ? await L.stripe("/subscriptions/" + subId).catch(() => null) : null;
        const hasta = L.finDePeriodo(sub) || new Date(Date.now() + 31 * 864e5).toISOString();
        await L.dbUpd("membresias", "perfil_id=eq." + m.perfil_id,
          { estado: "activa", acceso_hasta: hasta, actualizado: new Date().toISOString() });
        break;
      }

      /* Cambio de estado en Stripe. */
      case "customer.subscription.updated": {
        const m = await porSuscripcion(o.id);
        if (!m) break;
        const sanos = ["active", "trialing"];
        const estado = sanos.includes(o.status) ? "activa"
                     : (o.status === "canceled" ? "cancelada" : "vencida");
        const hasta = L.finDePeriodo(o);
        await L.dbUpd("membresias", "perfil_id=eq." + m.perfil_id,
          { estado, ...(hasta ? { acceso_hasta: hasta } : {}), actualizado: new Date().toISOString() });
        break;
      }

      /* Cancelacion definitiva: ESTE es el unico que quita el acceso. */
      case "customer.subscription.deleted": {
        const m = await porSuscripcion(o.id);
        if (!m) break;
        await L.dbUpd("membresias", "perfil_id=eq." + m.perfil_id,
          { estado: "cancelada", nivel: "ninguno", actualizado: new Date().toISOString() });
        await L.dbUpd("compras", "stripe_subscription=eq." + encodeURIComponent(o.id),
          { estado: "cancelada", actualizado: new Date().toISOString() }).catch(() => {});
        break;
      }

      /* Pago asincrono rechazado: la compra queda marcada y nunca se activo nada. */
      case "checkout.session.async_payment_failed": {
        await L.dbUpd("compras", "stripe_session=eq." + encodeURIComponent(o.id),
          { estado: "fallida", actualizado: new Date().toISOString() }).catch(() => {});
        break;
      }

      /* Cobro fallido de una renovacion: se MARCA, no se corta. Stripe reintenta durante dias y
         cortarle a alguien cuya tarjeta vencio es perder un cliente que si paga. */
      case "invoice.payment_failed": {
        const m = await porSuscripcion(L.subDeFactura(o));
        if (!m) break;
        await L.dbUpd("membresias", "perfil_id=eq." + m.perfil_id,
          { estado: "vencida", actualizado: new Date().toISOString() });
        break;
      }

      default: break;
    }

    await marcar(ev.id, ev.type);
    res.status(200).json({ ok: true });

  } catch (e) {
    /* 500 a proposito: el evento no quedo marcado, asi que Stripe reintenta. */
    console.error("webhook", ev && ev.type, e && e.message);
    res.status(500).json({ error: "procesando" });
  }
};
