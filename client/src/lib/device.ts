export function isHandheld(device = globalThis.navigator) {
  if (!device) return false;
  const mobile = (device as Navigator & { userAgentData?: { mobile: boolean } }).userAgentData?.mobile;
  return Boolean(mobile || /Android|iPhone|iPad|iPod/i.test(device.userAgent) || (device.platform === 'MacIntel' && device.maxTouchPoints > 1));
}
