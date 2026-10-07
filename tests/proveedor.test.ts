import { beforeAll, describe, expect, test } from "bun:test"
import ExcelJS from "exceljs"
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tools from "../src/tools/proveedor"

const FECHA = "2026-09-03"
const raiz = join(import.meta.dir, "..")
const dir = mkdtempSync(join(tmpdir(), "reto01-"))
cpSync(join(raiz, "fixtures"), join(dir, "fixtures"), { recursive: true })
const ctx = { directory: dir, sessionId: "test" }

type Campo = { etiqueta: string; valor: string; ruta: string; confianza: number; nota?: string }
type Resp = {
  ok: boolean
  error?: string
  data: {
    llenos: Campo[]
    faltantes: { etiqueta: string }[]
    requiere_confirmacion: Campo[]
    ruta: string
    formato: string
    soportado?: boolean
    listo_para_firma: boolean
    campos: { etiqueta: string; propuesta?: string; requiere_confirmacion?: boolean }[]
    checklist: { ausentes: string[]; vencidos: { tipo: string }[]; presentes: string[] }
  }
}
const run = async (s: Promise<string>) => JSON.parse(await s) as Resp
const leer = (rel: string) => readFileSync(join(dir, rel), "utf8")

beforeAll(() => {
  // plantilla corrupta para HU-5
  cpSync(join(dir, "fixtures/reto-01/casos/ec-corp-andina"), join(dir, "fixtures/reto-01/casos/caso-roto"), { recursive: true })
  writeFileSync(join(dir, "fixtures/reto-01/casos/caso-roto/plantilla-campos.json"), "{no es json")
})

describe("leer_solicitud", () => {
  test("EC: pdf, 15 campos y soportes", async () => {
    const r = await run(tools.leer_solicitud.execute({ caso: "ec-corp-andina" }, ctx))
    expect(r.ok).toBe(true)
    expect(r.data.formato).toBe("pdf")
    expect(r.data.campos).toHaveLength(15)
  })
  test("caso inexistente y path traversal devuelven error sin lanzar", async () => {
    expect((await run(tools.leer_solicitud.execute({ caso: "nope" }, ctx))).ok).toBe(false)
    expect((await run(tools.leer_solicitud.execute({ caso: "../../etc" }, ctx))).ok).toBe(false)
  })
  test("plantilla corrupta: error claro y el mapeo con campos explícitos sigue funcionando", async () => {
    const r = await run(tools.leer_solicitud.execute({ caso: "caso-roto" }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("corrupto")
    const m = await run(tools.mapear_campos.execute({ caso: "caso-roto", campos: ["Ciudad"] }, ctx))
    expect(m.ok).toBe(true)
    expect(m.data.llenos[0]?.valor).toBe("Medellín")
  })
})

describe("mapear_campos", () => {
  test("RN1 EC: RUC se llena con NIT y requiere confirmación; faltantes no inventados", async () => {
    const r = await run(tools.mapear_campos.execute({ caso: "ec-corp-andina" }, ctx))
    const ruc = r.data.requiere_confirmacion.find((c) => c.etiqueta === "RUC")
    expect(ruc?.valor).toBe("900123456")
    expect(ruc?.nota).toContain("identificador extranjero")
    expect(r.data.faltantes.map((f) => f.etiqueta)).toEqual(["Número de contribuyente especial"])
  })
  test("RN1 HN: RTN y faltante Referencias comerciales", async () => {
    const r = await run(tools.mapear_campos.execute({ caso: "hn-agroexport-sula" }, ctx))
    expect(r.data.requiere_confirmacion.map((c) => c.etiqueta)).toContain("RTN")
    expect(r.data.faltantes.map((f) => f.etiqueta)).toContain("Referencias comerciales")
  })
  test("confianza: exacta 1.0, normalizada 0.9, ruta del maestro", async () => {
    const r = await run(tools.mapear_campos.execute({ caso: "co-industrias-delta", campos: ["NIT", "razon  social", "Número de cuenta"] }, ctx))
    expect(r.data.llenos.find((c) => c.etiqueta === "NIT")?.confianza).toBe(1)
    const norm = r.data.llenos.find((c) => c.etiqueta === "razon  social")
    expect(norm?.confianza).toBe(0.9)
    expect(norm?.ruta).toBe("razon_social")
    expect(r.data.llenos.find((c) => c.etiqueta === "Número de cuenta")?.ruta).toBe("banco.numero_cuenta")
  })
  test("CO: NIT es lleno; 'Identificación tributaria' requiere confirmación", async () => {
    const r = await run(tools.mapear_campos.execute({ caso: "co-industrias-delta", campos: ["NIT", "Identificación tributaria"] }, ctx))
    expect(r.data.llenos.map((c) => c.etiqueta)).toEqual(["NIT"])
    expect(r.data.requiere_confirmacion[0]?.nota).toContain("NIT")
  })
  test("Ingresos anuales en COP con nota de moneda, sin convertir (HN)", async () => {
    const r = await run(tools.mapear_campos.execute({ caso: "hn-agroexport-sula" }, ctx))
    const ing = r.data.llenos.find((c) => c.etiqueta === "Ingresos anuales")
    expect(ing?.valor).toBe("98000000000 COP")
    expect(ing?.nota).toContain("COP")
  })
  test("leer_solicitud propone equivalente para etiqueta ambigua", async () => {
    // caso temporal con etiqueta ambigua
    cpSync(join(dir, "fixtures/reto-01/casos/ec-corp-andina"), join(dir, "fixtures/reto-01/casos/ambiguo"), { recursive: true })
    writeFileSync(join(dir, "fixtures/reto-01/casos/ambiguo/plantilla-campos.json"), JSON.stringify([{ etiqueta: "Identificación tributaria", obligatorio: true }]))
    const r = await run(tools.leer_solicitud.execute({ caso: "ambiguo" }, ctx))
    expect(r.data.campos[0]?.requiere_confirmacion).toBe(true)
    expect(r.data.campos[0]?.propuesta).toBe("RUC")
  })
})

describe("generar_formulario", () => {
  test("xlsx: etiqueta y valor en las celdas indicadas", async () => {
    const r = await run(tools.generar_formulario.execute({ caso: "co-industrias-delta" }, ctx))
    expect(r.data.ruta).toBe("out/co-industrias-delta/formulario.xlsx")
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(join(dir, r.data.ruta))
    expect(wb.getWorksheet("Datos Proveedor")?.getCell("B4").value).toBe("NIT")
    expect(wb.getWorksheet("Datos Proveedor")?.getCell("C4").value).toBe("900123456")
    expect(wb.getWorksheet("Datos Bancarios")?.getCell("C5").value).toBe("03100012345")
  })
  test("xlsx HN: faltante queda vacío", async () => {
    const r = await run(tools.generar_formulario.execute({ caso: "hn-agroexport-sula" }, ctx))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(join(dir, r.data.ruta))
    expect(wb.getWorksheet("Registro")?.getCell("B12").value ?? null).toBeNull()
    expect(wb.getWorksheet("Registro")?.getCell("B3").value).toBe("900123456")
  })
  test("pdf: archivo PDF válido", async () => {
    const r = await run(tools.generar_formulario.execute({ caso: "ec-corp-andina" }, ctx))
    expect(r.data.formato).toBe("pdf")
    expect(readFileSync(join(dir, r.data.ruta)).subarray(0, 4).toString()).toBe("%PDF")
  })
  test("portal: ok con soportado=false y valores-portal.md", async () => {
    const r = await run(tools.generar_formulario.execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(r.ok).toBe(true)
    expect(r.data.formato).toBe("portal")
    expect(r.data.soportado).toBe(false)
    expect(leer("out/pa-logistica-istmo/valores-portal.md")).toContain("900123456")
  })
})

describe("armar_paquete", () => {
  test("co: listo para firma con fecha de demo", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "co-industrias-delta", fecha_referencia: FECHA }, ctx))
    expect(r.data.listo_para_firma).toBe(true)
    for (const f of ["formulario.xlsx", "checklist.md", "borrador-correo.md", "soportes/rut-2026.txt"]) {
      expect(existsSync(join(dir, "out/co-industrias-delta/paquete", f))).toBe(true)
    }
  })
  test("ec: soporte ausente bloquea", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "ec-corp-andina", fecha_referencia: FECHA }, ctx))
    expect(r.data.listo_para_firma).toBe(false)
    expect(r.data.checklist.ausentes).toEqual(["certificado_cumplimiento_tributario"])
  })
  test("hn: parafiscales vencidos bloquean", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "hn-agroexport-sula", fecha_referencia: FECHA }, ctx))
    expect(r.data.listo_para_firma).toBe(false)
    expect(r.data.checklist.vencidos.map((v) => v.tipo)).toEqual(["parafiscales"])
    expect(leer("out/hn-agroexport-sula/paquete/checklist.md")).toContain("Referencias comerciales")
  })
  test("pa: portal listo", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "pa-logistica-istmo", fecha_referencia: FECHA }, ctx))
    expect(r.data.listo_para_firma).toBe(true)
  })
  test("con la fecha real la Cámara de Comercio vencida bloquea", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "co-industrias-delta", fecha_referencia: "2026-10-06" }, ctx))
    expect(r.data.listo_para_firma).toBe(false)
    expect(r.data.checklist.vencidos.map((v) => v.tipo)).toContain("camara_comercio")
  })
  test("fecha_referencia inválida devuelve error", async () => {
    const r = await run(tools.armar_paquete.execute({ caso: "co-industrias-delta", fecha_referencia: "03/09/2026" }, ctx))
    expect(r.ok).toBe(false)
  })
  test("RN2: borrador-correo.md nunca contiene datos bancarios", async () => {
    for (const caso of ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"]) {
      await tools.armar_paquete.execute({ caso, fecha_referencia: FECHA }, ctx)
      const correo = leer(`out/${caso}/paquete/borrador-correo.md`)
      for (const secreto of ["03100012345", "COLOCOBM", "Bancolombia", "Ahorros"]) expect(correo).not.toContain(secreto)
    }
  })
})

describe("simular_envio y logs", () => {
  test("sin confirmar: error; con confirmación: ENVIO-SIMULADO.md", async () => {
    const caso = "co-industrias-delta"
    await tools.armar_paquete.execute({ caso, fecha_referencia: FECHA }, ctx)
    const no = await run(tools.simular_envio.execute({ caso, confirmado: false }, ctx))
    expect(no).toEqual({ ok: false, error: "requiere confirmación explícita" } as unknown as Resp)
    expect(existsSync(join(dir, "out", caso, "ENVIO-SIMULADO.md"))).toBe(false)
    const si = await run(tools.simular_envio.execute({ caso, confirmado: true, fecha_referencia: FECHA }, ctx))
    expect(si.ok).toBe(true)
    expect(existsSync(join(dir, "out", caso, "ENVIO-SIMULADO.md"))).toBe(true)
  })
  test("sin paquete previo no envía", async () => {
    const r = await run(tools.simular_envio.execute({ caso: "ambiguo", confirmado: true }, ctx))
    expect(r.ok).toBe(false)
  })
  test("log por caso y global con ts, herramienta, ok, resumen", () => {
    for (const ruta of ["out/co-industrias-delta/log.jsonl", "out/log.jsonl"]) {
      const lineas = leer(ruta).trim().split("\n")
      const e = JSON.parse(lineas[0] ?? "{}") as Record<string, unknown>
      expect(Object.keys(e)).toEqual(expect.arrayContaining(["ts", "herramienta", "ok", "resumen"]))
    }
  })
  test("el log no contiene datos bancarios", () => {
    expect(leer("out/log.jsonl")).not.toContain("03100012345")
  })
})
