import { z } from "zod"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Tipos y esquemas
// ---------------------------------------------------------------------------

export type Ctx = { directory: string; sessionId: string }

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/
const CASO_RE = /^[a-z0-9][a-z0-9-]*$/

const solicitudSchema = z.object({
  id: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  cuerpo: z.string().optional(),
  adjuntos: z.array(z.string()).optional(),
})
const celdasSchema = z.array(
  z.object({ hoja: z.string(), celda_etiqueta: z.string(), etiqueta: z.string(), celda_valor: z.string() }),
)
const camposSchema = z.array(z.object({ etiqueta: z.string(), obligatorio: z.boolean() }))
const soportesExigidosSchema = z.array(z.string())
const indiceSoportesSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string().optional(),
  }),
)
const glosarioSchema = z.record(z.string(), z.string())
const maestroSchema = z.record(z.string(), z.unknown())

const campoMapeadoSchema = z.object({
  etiqueta: z.string(),
  valor: z.string(),
  ruta: z.string(),
  confianza: z.number(),
  nota: z.string().optional(),
})
const faltanteSchema = z.object({ etiqueta: z.string(), motivo: z.string() })
const mapeoSchema = z.object({
  llenos: z.array(campoMapeadoSchema),
  faltantes: z.array(faltanteSchema),
  requiere_confirmacion: z.array(campoMapeadoSchema),
})

type Solicitud = z.infer<typeof solicitudSchema>
type Celda = z.infer<typeof celdasSchema>[number]
type Mapeo = z.infer<typeof mapeoSchema>
type CampoMapeado = z.infer<typeof campoMapeadoSchema>
type Soporte = z.infer<typeof indiceSoportesSchema>[number]
type Plantilla =
  | { tipo: "celdas"; celdas: Celda[] }
  | { tipo: "campos"; campos: { etiqueta: string; obligatorio: boolean }[] }
type Resultado = { ok: true; data: unknown; resumen: string } | { ok: false; error: string }

class ErrorHerramienta extends Error {}

const IDENTIFICADOR_POR_PAIS: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }
const ETIQUETAS_AMBIGUAS = new Set(["identificacion tributaria", "numero de identificacion fiscal"])

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const fixturesDir = (ctx: Ctx) => join(ctx.directory, "fixtures", "reto-01")
const casoDir = (ctx: Ctx, caso: string) => join(fixturesDir(ctx), "casos", caso)
const outDir = (ctx: Ctx, caso: string) => join(ctx.directory, "out", caso)
const relOut = (caso: string, ...partes: string[]) => ["out", caso, ...partes].join("/")

function hoy(): string {
  return new Date().toISOString().slice(0, 10)
}

function resolverFecha(fecha?: string): string {
  const f = fecha ?? hoy()
  const valida = FECHA_RE.test(f) && !Number.isNaN(Date.parse(f)) && new Date(f).toISOString().slice(0, 10) === f
  if (!valida) throw new ErrorHerramienta(`fecha_referencia inválida: "${f}". Use el formato YYYY-MM-DD.`)
  return f
}

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

async function leerJson<T>(ruta: string, schema: z.ZodType<T>, descripcion: string): Promise<T> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    throw new ErrorHerramienta(`No se encontró ${descripcion}.`)
  }
  let crudo: unknown
  try {
    crudo = JSON.parse(texto)
  } catch {
    throw new ErrorHerramienta(`${descripcion} está corrupto (JSON inválido).`)
  }
  const r = schema.safeParse(crudo)
  if (!r.success) throw new ErrorHerramienta(`${descripcion} no tiene el formato esperado.`)
  return r.data
}

async function cargarSolicitud(ctx: Ctx, caso: string): Promise<Solicitud> {
  if (!CASO_RE.test(caso) || !existsSync(casoDir(ctx, caso))) {
    throw new ErrorHerramienta(`El caso "${caso}" no existe en fixtures/reto-01/casos/.`)
  }
  return leerJson(join(casoDir(ctx, caso), "solicitud.json"), solicitudSchema, "solicitud.json")
}

async function cargarPlantilla(ctx: Ctx, caso: string, solicitud: Solicitud): Promise<Plantilla> {
  if (solicitud.formato === "xlsx") {
    const celdas = await leerJson(join(casoDir(ctx, caso), "plantilla-celdas.json"), celdasSchema, "plantilla-celdas.json")
    return { tipo: "celdas", celdas }
  }
  const campos = await leerJson(join(casoDir(ctx, caso), "plantilla-campos.json"), camposSchema, "plantilla-campos.json")
  return { tipo: "campos", campos }
}

async function cargarSoportesExigidos(ctx: Ctx, caso: string): Promise<string[]> {
  return leerJson(join(casoDir(ctx, caso), "soportes-exigidos.json"), soportesExigidosSchema, "soportes-exigidos.json")
}

const etiquetasDe = (p: Plantilla): string[] =>
  p.tipo === "celdas" ? p.celdas.map((c) => c.etiqueta) : p.campos.map((c) => c.etiqueta)

function leerRuta(obj: unknown, ruta: string): unknown {
  let actual: unknown = obj
  for (const clave of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null) return undefined
    actual = (actual as Record<string, unknown>)[clave]
  }
  return actual
}

function valorTexto(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() === "" ? undefined : v
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "Sí" : "No"
  return undefined
}

async function registrar(ctx: Ctx, caso: string, herramienta: string, ok: boolean, resumen: string): Promise<void> {
  try {
    const linea =
      JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, caso, herramienta, ok, resumen }) + "\n"
    await mkdir(join(ctx.directory, "out"), { recursive: true })
    await appendFile(join(ctx.directory, "out", "log.jsonl"), linea)
    if (CASO_RE.test(caso) && existsSync(casoDir(ctx, caso))) {
      await mkdir(outDir(ctx, caso), { recursive: true })
      await appendFile(join(outDir(ctx, caso), "log.jsonl"), linea)
    }
  } catch {
    // el log nunca debe romper la herramienta
  }
}

async function ejecutar(nombre: string, ctx: Ctx, caso: string, fn: () => Promise<Resultado>): Promise<string> {
  let resultado: Resultado
  try {
    resultado = await fn()
  } catch (e) {
    const msg =
      e instanceof ErrorHerramienta ? e.message : "Error inesperado al ejecutar la herramienta. Revise los datos del caso."
    resultado = { ok: false, error: msg }
  }
  await registrar(ctx, caso, nombre, resultado.ok, resultado.ok ? resultado.resumen : resultado.error)
  return JSON.stringify(resultado.ok ? { ok: true, data: resultado.data } : { ok: false, error: resultado.error })
}

// ---------------------------------------------------------------------------
// Mapeo (HU-2, RN1)
// ---------------------------------------------------------------------------

function tokens(s: string): Set<string> {
  return new Set(
    normalizar(s)
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((t) => b.has(t)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : inter / union
}

type Resolucion = { clave: string; confianza: number; aproximada?: string }

function resolverGlosario(etiqueta: string, glosario: Record<string, string>): Resolucion | undefined {
  const exacta = glosario[etiqueta]
  if (exacta !== undefined && Object.hasOwn(glosario, etiqueta)) return { clave: exacta, confianza: 1.0 }
  const norm = normalizar(etiqueta)
  for (const [k, v] of Object.entries(glosario)) {
    if (normalizar(k) === norm) return { clave: v, confianza: 0.9 }
  }
  let mejor: { k: string; v: string; s: number } | undefined
  const t = tokens(etiqueta)
  for (const [k, v] of Object.entries(glosario)) {
    const s = jaccard(t, tokens(k))
    if (s >= 0.6 && (!mejor || s > mejor.s)) mejor = { k, v, s }
  }
  return mejor ? { clave: mejor.v, confianza: Math.round(mejor.s * 79) / 100, aproximada: mejor.k } : undefined
}

function mapear(
  etiquetas: string[],
  pais: string,
  glosario: Record<string, string>,
  maestro: Record<string, unknown>,
): Mapeo {
  const mapeo: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  const ident = IDENTIFICADOR_POR_PAIS[pais] ?? "identificador tributario"
  for (const etiqueta of etiquetas) {
    const res = resolverGlosario(etiqueta, glosario)
    if (!res) {
      mapeo.faltantes.push({ etiqueta, motivo: "No existe en el glosario ni en el maestro; no se inventa." })
      continue
    }
    const valor = valorTexto(leerRuta(maestro, res.clave))
    if (valor === undefined) {
      mapeo.faltantes.push({ etiqueta, motivo: `El dato "${res.clave}" no tiene valor en el maestro.` })
      continue
    }
    const campo: CampoMapeado = { etiqueta, valor, ruta: res.clave, confianza: res.confianza }
    const notas: string[] = []
    let confirmar = res.confianza < 0.8
    if (res.aproximada) notas.push(`Coincidencia aproximada con "${res.aproximada}".`)
    if (res.clave === "nit") {
      if (pais !== "CO") {
        confirmar = true
        notas.push(
          `identificador extranjero: Periferia solo tiene NIT colombiano; se llenó con el NIT para el ${ident} de ${pais}.`,
        )
      }
      if (ETIQUETAS_AMBIGUAS.has(normalizar(etiqueta))) {
        confirmar = true
        notas.push(`Etiqueta ambigua; equivalente en ${pais}: ${ident}.`)
      }
    }
    if (res.clave === "ingresos_ultimo_ano.valor") {
      const moneda = valorTexto(leerRuta(maestro, "ingresos_ultimo_ano.moneda")) ?? "COP"
      campo.valor = `${valor} ${moneda}`
      notas.push(`Valor en ${moneda} (moneda del maestro); no se convirtió a la moneda del cliente.`)
    }
    if (notas.length > 0) campo.nota = notas.join(" ")
    if (confirmar) mapeo.requiere_confirmacion.push(campo)
    else mapeo.llenos.push(campo)
  }
  return mapeo
}

async function calcularMapeo(ctx: Ctx, solicitud: Solicitud, etiquetas: string[]): Promise<Mapeo> {
  const glosario = await leerJson(join(fixturesDir(ctx), "glosario-campos.json"), glosarioSchema, "glosario-campos.json")
  const maestro = await leerJson(join(fixturesDir(ctx), "repositorio", "maestro.json"), maestroSchema, "maestro.json")
  return mapear(etiquetas, solicitud.pais, glosario, maestro)
}

// ---------------------------------------------------------------------------
// Generación de formularios (HU-3)
// ---------------------------------------------------------------------------

function valorPara(mapeo: Mapeo, etiqueta: string): string | undefined {
  return [...mapeo.llenos, ...mapeo.requiere_confirmacion].find((c) => c.etiqueta === etiqueta)?.valor
}

async function generarXlsx(ctx: Ctx, caso: string, celdas: Celda[], mapeo: Mapeo): Promise<string> {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Agente Registro Proveedor"
  const hojas = new Map<string, ExcelJS.Worksheet>()
  for (const c of celdas) {
    let hoja = hojas.get(c.hoja)
    if (!hoja) {
      hoja = wb.addWorksheet(c.hoja)
      hojas.set(c.hoja, hoja)
    }
    hoja.getCell(c.celda_etiqueta).value = c.etiqueta
    const valor = valorPara(mapeo, c.etiqueta)
    if (valor !== undefined) hoja.getCell(c.celda_valor).value = valor
  }
  for (const hoja of hojas.values()) hoja.columns.forEach((col) => (col.width = 40))
  await mkdir(outDir(ctx, caso), { recursive: true })
  await wb.xlsx.writeFile(join(outDir(ctx, caso), "formulario.xlsx"))
  return relOut(caso, "formulario.xlsx")
}

function aLatin1(s: string): string {
  return s.replace(/[^ -~ -ÿ]/g, "?")
}

function envolver(texto: string, font: PDFFont, size: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (actual && font.widthOfTextAtSize(prueba, size) > ancho) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas
}

async function generarPdf(
  ctx: Ctx,
  caso: string,
  solicitud: Solicitud,
  campos: { etiqueta: string }[],
  mapeo: Mapeo,
): Promise<string> {
  const doc = await PDFDocument.create()
  const fecha = new Date(solicitud.fecha)
  doc.setCreationDate(fecha)
  doc.setModificationDate(fecha)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ancho = 595
  const alto = 842
  const margen = 50
  let page = doc.addPage([ancho, alto])
  let y = alto - margen
  const escribir = (texto: string, f: PDFFont, s: number) => {
    for (const linea of envolver(aLatin1(texto), f, s, ancho - 2 * margen)) {
      if (y < margen) {
        page = doc.addPage([ancho, alto])
        y = alto - margen
      }
      page.drawText(linea, { x: margen, y, size: s, font: f })
      y -= s + 6
    }
  }
  escribir(`Formulario de registro de proveedor - ${solicitud.cliente}`, bold, 14)
  y -= 8
  for (const c of campos) {
    escribir(`${c.etiqueta}: ${valorPara(mapeo, c.etiqueta) ?? "(faltante)"}`, font, 11)
  }
  await mkdir(outDir(ctx, caso), { recursive: true })
  await writeFile(join(outDir(ctx, caso), "formulario.pdf"), await doc.save())
  return relOut(caso, "formulario.pdf")
}

async function generarPortal(
  ctx: Ctx,
  caso: string,
  solicitud: Solicitud,
  etiquetas: string[],
  mapeo: Mapeo,
): Promise<string> {
  const celda = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
  const filas = etiquetas.map((e) => {
    const c = [...mapeo.llenos, ...mapeo.requiere_confirmacion].find((x) => x.etiqueta === e)
    const f = mapeo.faltantes.find((x) => x.etiqueta === e)
    return `| ${celda(e)} | ${c ? celda(c.valor) : "(faltante)"} | ${celda(c?.nota ?? f?.motivo ?? "")} |`
  })
  const md = [
    `# Valores para el portal - ${solicitud.cliente}`,
    "",
    "Formato no soportado: el portal web lo opera una persona (credenciales y envío son humanos). Copie estos valores en el formulario en línea.",
    "",
    "| Campo | Valor | Nota |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n")
  await mkdir(outDir(ctx, caso), { recursive: true })
  await writeFile(join(outDir(ctx, caso), "valores-portal.md"), md)
  return relOut(caso, "valores-portal.md")
}

async function producirFormulario(ctx: Ctx, caso: string, solicitud: Solicitud, plantilla: Plantilla, mapeo: Mapeo) {
  if (plantilla.tipo === "celdas") {
    return { ruta: await generarXlsx(ctx, caso, plantilla.celdas, mapeo), formato: "xlsx" as const }
  }
  if (solicitud.formato === "pdf") {
    return { ruta: await generarPdf(ctx, caso, solicitud, plantilla.campos, mapeo), formato: "pdf" as const }
  }
  return { ruta: await generarPortal(ctx, caso, solicitud, etiquetasDe(plantilla), mapeo), formato: "portal" as const }
}

// ---------------------------------------------------------------------------
// Soportes y paquete (HU-4, RN3)
// ---------------------------------------------------------------------------

type EstadoSoportes = {
  presentes: { tipo: string; archivo: string; vigencia_hasta: string | null }[]
  ausentes: string[]
  vencidos: { tipo: string; archivo: string; vigencia_hasta: string }[]
}

async function evaluarSoportes(ctx: Ctx, exigidos: string[], fecha: string): Promise<EstadoSoportes> {
  const dirSoportes = join(fixturesDir(ctx), "repositorio", "soportes")
  const indice = await leerJson(join(dirSoportes, "index.json"), indiceSoportesSchema, "el índice de soportes")
  const estado: EstadoSoportes = { presentes: [], ausentes: [], vencidos: [] }
  for (const tipo of exigidos) {
    const s: Soporte | undefined = indice.find((x) => x.tipo === tipo)
    if (!s || !existsSync(join(dirSoportes, s.archivo))) {
      estado.ausentes.push(tipo)
    } else if (s.vigencia_hasta !== null && s.vigencia_hasta < fecha) {
      estado.vencidos.push({ tipo, archivo: s.archivo, vigencia_hasta: s.vigencia_hasta })
    } else {
      estado.presentes.push({ tipo, archivo: s.archivo, vigencia_hasta: s.vigencia_hasta })
    }
  }
  return estado
}

const listoParaFirma = (e: EstadoSoportes) => e.ausentes.length === 0 && e.vencidos.length === 0

function checklistMd(caso: string, fecha: string, e: EstadoSoportes, mapeo: Mapeo, listo: boolean): string {
  const lista = (items: string[]) => (items.length ? items : ["(ninguno)"]).map((i) => `- ${i}`)
  return [
    `# Checklist - ${caso}`,
    "",
    `Fecha de referencia: ${fecha}`,
    `Estado: ${listo ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA (hay soportes ausentes o vencidos)"}`,
    "",
    "## Soportes presentes",
    ...lista(e.presentes.map((s) => `${s.tipo} (${s.archivo}, vigencia: ${s.vigencia_hasta ?? "sin vencimiento"})`)),
    "",
    "## Soportes ausentes",
    ...lista(e.ausentes),
    "",
    "## Soportes vencidos",
    ...lista(e.vencidos.map((s) => `${s.tipo} (${s.archivo}, venció el ${s.vigencia_hasta})`)),
    "",
    "## Campos faltantes (no bloquean la firma)",
    ...lista(mapeo.faltantes.map((f) => f.etiqueta)),
    "",
    "## Campos por confirmar",
    ...lista(mapeo.requiere_confirmacion.map((c) => `${c.etiqueta}${c.nota ? ` - ${c.nota}` : ""}`)),
    "",
  ].join("\n")
}

// RN2: el borrador de correo nunca incluye datos bancarios.
function borradorCorreoMd(solicitud: Solicitud, e: EstadoSoportes, representante: string): string {
  return [
    "# Borrador de correo (no enviar hasta la firma del representante legal)",
    "",
    `**Para:** ${solicitud.cliente}`,
    `**Asunto:** Re: ${solicitud.asunto}`,
    "",
    "Estimados señores,",
    "",
    "Adjuntamos el formulario de registro como proveedor diligenciado y firmado por el representante legal, junto con los siguientes soportes:",
    "",
    ...(e.presentes.length ? e.presentes.map((s) => `- ${s.tipo}`) : ["- (ninguno disponible)"]),
    "",
    "Quedamos atentos a cualquier observación.",
    "",
    "Cordialmente,",
    representante,
    "Periferia IT Group",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. ec-corp-andina)")
const argFecha = z
  .string()
  .optional()
  .describe("Fecha de referencia YYYY-MM-DD para evaluar vigencias de soportes (opcional, por defecto hoy)")

export const leer_solicitud = {
  description:
    "Lee la solicitud del cliente y su plantilla: devuelve país, cliente, formato, campos pedidos y soportes exigidos.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return ejecutar("leer_solicitud", ctx, args.caso, async () => {
      const solicitud = await cargarSolicitud(ctx, args.caso)
      const plantilla = await cargarPlantilla(ctx, args.caso, solicitud)
      const soportes = await cargarSoportesExigidos(ctx, args.caso)
      const ident = IDENTIFICADOR_POR_PAIS[solicitud.pais] ?? "identificador tributario"
      const base =
        plantilla.tipo === "celdas"
          ? plantilla.celdas.map((c) => ({ etiqueta: c.etiqueta, hoja: c.hoja, celda_valor: c.celda_valor }))
          : plantilla.campos
      const campos = base.map((c) =>
        ETIQUETAS_AMBIGUAS.has(normalizar(c.etiqueta)) ? { ...c, requiere_confirmacion: true, propuesta: ident } : c,
      )
      const data = {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        fecha: solicitud.fecha,
        asunto: solicitud.asunto,
        identificador_tributario: ident,
        campos,
        soportes,
      }
      return {
        ok: true,
        data,
        resumen: `${campos.length} campos, ${soportes.length} soportes, formato ${solicitud.formato}, país ${solicitud.pais}`,
      }
    })
  },
}

export const mapear_campos = {
  description:
    "Cruza los campos solicitados con el maestro y el glosario: devuelve llenos, faltantes y por confirmar (sin inventar valores).",
  args: {
    caso: argCaso,
    campos: z.array(z.string()).optional().describe("Etiquetas a mapear (opcional; por defecto las de la plantilla del caso)"),
  },
  async execute(args: { caso: string; campos?: string[] | undefined }, ctx: Ctx): Promise<string> {
    return ejecutar("mapear_campos", ctx, args.caso, async () => {
      const solicitud = await cargarSolicitud(ctx, args.caso)
      const etiquetas = args.campos ?? etiquetasDe(await cargarPlantilla(ctx, args.caso, solicitud))
      const mapeo = await calcularMapeo(ctx, solicitud, etiquetas)
      return {
        ok: true,
        data: mapeo,
        resumen: `${mapeo.llenos.length} llenos, ${mapeo.faltantes.length} faltantes, ${mapeo.requiere_confirmacion.length} por confirmar`,
      }
    })
  },
}

export const generar_formulario = {
  description: "Genera el formulario en el formato pedido (xlsx, pdf o valores-portal.md para portales) en out/<caso>/.",
  args: {
    caso: argCaso,
    mapeo: mapeoSchema.optional().describe("Resultado de mapear_campos (opcional; si falta se calcula)"),
  },
  async execute(args: { caso: string; mapeo?: Mapeo | undefined }, ctx: Ctx): Promise<string> {
    return ejecutar("generar_formulario", ctx, args.caso, async () => {
      const solicitud = await cargarSolicitud(ctx, args.caso)
      const plantilla = await cargarPlantilla(ctx, args.caso, solicitud)
      const mapeo = args.mapeo ?? (await calcularMapeo(ctx, solicitud, etiquetasDe(plantilla)))
      const r = await producirFormulario(ctx, args.caso, solicitud, plantilla, mapeo)
      const data =
        r.formato === "portal"
          ? { ...r, soportado: false, mensaje: "formato no soportado: valores listos para copiar en valores-portal.md" }
          : r
      return { ok: true, data, resumen: `${r.formato} -> ${r.ruta}` }
    })
  },
}

export const armar_paquete = {
  description:
    "Arma out/<caso>/paquete/ con formulario, soportes, checklist.md y borrador-correo.md; indica si está listo para firma.",
  args: { caso: argCaso, fecha_referencia: argFecha },
  async execute(args: { caso: string; fecha_referencia?: string | undefined }, ctx: Ctx): Promise<string> {
    return ejecutar("armar_paquete", ctx, args.caso, async () => {
      const fecha = resolverFecha(args.fecha_referencia)
      const solicitud = await cargarSolicitud(ctx, args.caso)
      const plantilla = await cargarPlantilla(ctx, args.caso, solicitud)
      const exigidos = await cargarSoportesExigidos(ctx, args.caso)
      const mapeo = await calcularMapeo(ctx, solicitud, etiquetasDe(plantilla))
      const form = await producirFormulario(ctx, args.caso, solicitud, plantilla, mapeo)
      const estado = await evaluarSoportes(ctx, exigidos, fecha)
      const listo = listoParaFirma(estado)

      const paquete = join(outDir(ctx, args.caso), "paquete")
      await rm(paquete, { recursive: true, force: true })
      await mkdir(join(paquete, "soportes"), { recursive: true })
      await copyFile(join(ctx.directory, form.ruta), join(paquete, form.ruta.split("/").pop() ?? "formulario"))
      const origen = join(fixturesDir(ctx), "repositorio", "soportes")
      for (const s of [...estado.presentes, ...estado.vencidos]) {
        await copyFile(join(origen, s.archivo), join(paquete, "soportes", s.archivo))
      }
      const maestro = await leerJson(join(fixturesDir(ctx), "repositorio", "maestro.json"), maestroSchema, "maestro.json")
      const representante = valorTexto(leerRuta(maestro, "representante_legal.nombre")) ?? "Representante legal"
      await writeFile(join(paquete, "checklist.md"), checklistMd(args.caso, fecha, estado, mapeo, listo))
      await writeFile(join(paquete, "borrador-correo.md"), borradorCorreoMd(solicitud, estado, representante))

      const checklist = {
        presentes: estado.presentes.map((s) => s.tipo),
        ausentes: estado.ausentes,
        vencidos: estado.vencidos.map((s) => ({ tipo: s.tipo, vigencia_hasta: s.vigencia_hasta })),
        campos_faltantes: mapeo.faltantes.map((f) => f.etiqueta),
        campos_por_confirmar: mapeo.requiere_confirmacion.map((c) => c.etiqueta),
      }
      return {
        ok: true,
        data: { ruta: relOut(args.caso, "paquete"), listo_para_firma: listo, fecha_referencia: fecha, checklist },
        resumen: `listo_para_firma=${listo}; ausentes=${estado.ausentes.length}; vencidos=${estado.vencidos.length}`,
      }
    })
  },
}

export const simular_envio = {
  description:
    "Simula el envío del paquete escribiendo ENVIO-SIMULADO.md; exige confirmado=true tras la confirmación explícita del usuario.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
    fecha_referencia: argFecha,
  },
  async execute(
    args: { caso: string; confirmado: boolean; fecha_referencia?: string | undefined },
    ctx: Ctx,
  ): Promise<string> {
    return ejecutar("simular_envio", ctx, args.caso, async () => {
      if (args.confirmado !== true) return { ok: false, error: "requiere confirmación explícita" }
      const fecha = resolverFecha(args.fecha_referencia)
      const solicitud = await cargarSolicitud(ctx, args.caso)
      if (!existsSync(join(outDir(ctx, args.caso), "paquete", "checklist.md"))) {
        return { ok: false, error: "Primero debe armarse el paquete (armar_paquete) para este caso." }
      }
      const estado = await evaluarSoportes(ctx, await cargarSoportesExigidos(ctx, args.caso), fecha)
      const listo = listoParaFirma(estado)
      const md = [
        `# ENVIO SIMULADO - ${args.caso}`,
        "",
        "No se envió nada: es una simulación para el reto.",
        "",
        `- Destinatario: ${solicitud.cliente}`,
        `- Paquete: ${relOut(args.caso, "paquete")}`,
        `- Fecha de referencia: ${fecha}`,
        `- Listo para firma: ${listo ? "sí" : "NO (soportes ausentes o vencidos)"}`,
        ...(listo
          ? []
          : ["", "ADVERTENCIA: el paquete tiene soportes ausentes o vencidos; la persona responsable decidió continuar."]),
        "",
      ].join("\n")
      await writeFile(join(outDir(ctx, args.caso), "ENVIO-SIMULADO.md"), md)
      return {
        ok: true,
        data: { ruta: relOut(args.caso, "ENVIO-SIMULADO.md"), listo_para_firma: listo },
        resumen: `ENVIO-SIMULADO.md (listo=${listo})`,
      }
    })
  },
}
