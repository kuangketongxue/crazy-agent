(async () => {
  const m = await import('../lib/db.ts');
  console.log(Object.keys(m));
})();
