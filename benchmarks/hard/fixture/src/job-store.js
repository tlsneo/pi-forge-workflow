export class JobStore {
  #jobs = new Map();

  save(job) {
    this.#jobs.set(job.id, structuredClone(job));
  }

  find(id) {
    const job = this.#jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }
}
