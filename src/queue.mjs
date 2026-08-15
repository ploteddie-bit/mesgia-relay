/** File FIFO séquentielle : un seul traitement à la fois, jamais de rejet silencieux. */
export function createFifo(handler, onError = () => {}) {
  let chain = Promise.resolve()
  return (item) => {
    chain = chain.then(() => handler(item)).catch((err) => onError(err))
  }
}
