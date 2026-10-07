# Conocimiento: registro como proveedor

## Flujo del proceso

Llega un correo de un cliente (Colombia, Ecuador, Perú, Panamá u Honduras) con una plantilla en uno de tres formatos: Excel (xlsx), PDF o portal web. El agente lee la solicitud, cruza cada campo con el repositorio maestro de Periferia, genera el formulario, arma el paquete para la firma del representante legal y, solo con confirmación humana, simula el envío.

Flujo: `leer_solicitud` → `mapear_campos` → `generar_formulario` → `armar_paquete` → `simular_envio`.

## Estados de un campo

- **lleno**: tiene valor y ruta de su fuente en el maestro.
- **faltante**: no existe en el maestro. Nunca se inventa. Aparece en el reporte y en el checklist.
- **requiere_confirmacion**: mapeo con confianza menor a 0.8, etiqueta ambigua o regla de país. Se llena con la mejor propuesta y la analista debe verificarla.

Los sinónimos del glosario de campos se resuelven automáticamente.

## Reglas de negocio

| Regla | Descripción |
|---|---|
| RN1 | El identificador tributario depende del país: CO NIT, EC RUC, PE RUC, PA RUC, HN RTN. Periferia solo tiene NIT colombiano; en otros países el campo se llena con el NIT y queda en requiere_confirmacion con la nota "identificador extranjero". Etiquetas ambiguas como "Identificación tributaria" también quedan en requiere_confirmacion con el equivalente del país. |
| RN2 | Los datos bancarios se llenan solo si la plantilla los pide explícitamente. Nunca se incluyen en el borrador de correo. |
| RN3 | Un soporte vencido (vigencia_hasta anterior a la fecha de referencia) bloquea listo_para_firma. Un soporte exigido ausente también. Un campo faltante no lo bloquea, pero aparece en el checklist. |
| RN4 | Ninguna acción externa (envío, firma, carga a portal) sin confirmación explícita del usuario en el turno inmediatamente anterior. |
| RN5 | Toda ejecución deja un registro en `out/<caso>/log.jsonl` con ts, herramienta, ok y resumen. |

## Fecha de referencia

La vigencia de los soportes se evalúa contra una `fecha_referencia` (YYYY-MM-DD). Si no se indica, es la fecha de hoy. La demo usa una fecha fija (2026-09-03) para ser determinista.

## Formatos de salida

- **xlsx**: `out/<caso>/formulario.xlsx`, cada etiqueta y valor en la hoja y celda de la plantilla.
- **pdf**: `out/<caso>/formulario.pdf`, todos los campos con etiqueta y valor en el orden dado.
- **portal**: no soportado; se produce `out/<caso>/valores-portal.md` con los valores listos para copiar. El humano opera el portal.

## Paquete para firma

`out/<caso>/paquete/` contiene el formulario, copias de los soportes exigidos que existan, `checklist.md` (presentes, ausentes, vencidos y campos por confirmar o faltantes) y `borrador-correo.md` (sin datos bancarios). El agente termina preguntando si se confirma el envío; enviar solo escribe `ENVIO-SIMULADO.md`.
