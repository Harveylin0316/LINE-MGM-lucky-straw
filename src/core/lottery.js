function pickPrizeByQuantity(prizes) {
  const valid = prizes.filter(p => Number(p.quantity) > 0);
  const totalQty = valid.reduce((sum, p) => sum + Number(p.quantity), 0);
  let rand = Math.floor(Math.random() * totalQty);
  for (const prize of valid) {
    rand -= Number(prize.quantity);
    if (rand < 0) return prize;
  }
  return valid[valid.length - 1];
}

function enrichPrizesWithHitRate(prizes) {
  const totalQty = prizes.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  return prizes.map(p => ({
    ...p,
    hitRate: `${(totalQty > 0 ? (Number(p.quantity || 0) / totalQty) * 100 : 0).toFixed(2)}%`
  }));
}

module.exports = {
  pickPrizeByQuantity,
  enrichPrizesWithHitRate
};
