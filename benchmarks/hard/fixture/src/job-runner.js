export async function runJob(store, job, perform) {
  store.save({ ...job, status: "running" });
  try {
    const result = await perform(job.payload);
    store.save({ ...job, status: "completed", result });
    return result;
  } catch (error) {
    store.save({ ...job, status: "failed", error: error.message });
    throw error;
  }
}
