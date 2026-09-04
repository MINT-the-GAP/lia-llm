export function qualityRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isFatalQualityEngineError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ""
  const message = qualityRuntimeErrorMessage(error)
  const text = `${name}: ${message}`
  return /(?:device\s+(?:was\s+)?lost|device[-_ ]?lost|dxgi_error_device_(?:hung|removed|reset)|vk_error_device_lost|(?:object|tensor) has already been disposed|current object has already been disposed|cannot pass deleted object|buffer(?:\s+is)?\s+unmapped|unmapped\s+(?:gpu\s+)?buffer|buffer\s+is\s+not\s+mapped|model(?:not)?loadederror|model has not been loaded|out of (?:gpu )?memory|\boom\b|memory allocation|gpu[^\n]{0,80}(?:hang|lost)|runtimeerror[^\n]{0,40}aborted|check failed[^\n]{0,80}grammar)/iu.test(
    text,
  )
}
