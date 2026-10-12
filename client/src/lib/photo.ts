export async function resizePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo to share with your companion.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.65, 0.45, 0.25]) {
    const data = canvas.toDataURL('image/jpeg', quality);
    if (Math.ceil(data.split(',')[1].length * 3 / 4) <= 150_000) return data;
  }
  throw new Error('That photo could not be made small enough. Try another.');
}
