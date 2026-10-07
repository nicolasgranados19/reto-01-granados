import { rm, readdir } from "node:fs/promises"
import { join } from "node:path"
import * as tools from "./src/tools/proveedor"

const FECHA_DEMO = "2026-09-03"
const ctx = { directory: import.meta.dir, sessionId: "demo" }

type Json = { ok: boolean; data?: Record<string, unknown>; error?: string }
const parse = (s: string): Json => JSON.parse(s) as Json
const len = (v: unknown) => (Array.isArray(v) ? v.length : 0)

await rm(join(ctx.directory, "out"), { recursive: true, force: true })
const casos = (await readdir(join(ctx.directory, "fixtures", "reto-01", "casos"))).sort()
console.log(`Demo sin modelo - fecha de referencia ${FECHA_DEMO}\n`)

const filas: Record<string, string | number | boolean>[] = []
for (const caso of casos) {
  const sol = parse(await tools.leer_solicitud.execute({ caso }, ctx))
  const mapeo = parse(await tools.mapear_campos.execute({ caso }, ctx))
  const form = parse(await tools.generar_formulario.execute({ caso }, ctx))
  const paq = parse(await tools.armar_paquete.execute({ caso, fecha_referencia: FECHA_DEMO }, ctx))
  const envio = parse(await tools.simular_envio.execute({ caso, confirmado: false }, ctx))
  const cl = (paq.data?.checklist ?? {}) as Record<string, unknown>
  const m = mapeo.data ?? {}
  filas.push({
    caso,
    formato: String(sol.data?.formato ?? sol.error),
    llenos: len(m.llenos),
    faltantes: len(m.faltantes),
    por_confirmar: len(m.requiere_confirmacion),
    sop_presentes: len(cl.presentes),
    sop_ausentes: len(cl.ausentes),
    sop_vencidos: len(cl.vencidos),
    listo_para_firma: Boolean(paq.data?.listo_para_firma),
    formulario: String(form.data?.ruta ?? form.error),
    envio_sin_confirmar: envio.ok ? "ERROR: permitido" : `rechazado (${envio.error})`,
  })
  console.log(`- ${caso}: faltantes=${JSON.stringify(cl.campos_faltantes)} ausentes=${JSON.stringify(cl.ausentes)} vencidos=${JSON.stringify(cl.vencidos)}`)
}
console.log()
console.table(filas)

// Con confirmación explícita (caso listo) solo se escribe ENVIO-SIMULADO.md
const conf = parse(await tools.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true, fecha_referencia: FECHA_DEMO }, ctx))
console.log(`simular_envio(co-industrias-delta, confirmado=true) -> ${conf.ok ? String(conf.data?.ruta) : conf.error}`)
