import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";

type Entry = { address: `0x${string}`; score: number };

export default function Leaderboard({ entries }: { entries: Entry[] }) {
  const { address } = useAccount();
  const [myRank, setMyRank] = useState<number | null>(null);

  // যদি ব্যাকএন্ড র‍্যাঙ্ক API থাকে:
  useEffect(() => {
    if (!address) return;
    (async () => {
      try {
        const r = await fetch(`/api/leaderboard/rank?address=${address}`);
        if (r.ok) {
          const { rank } = await r.json();
          setMyRank(rank ?? null);
        } else {
          // ফালব্যাক: লোকাল হিসাব
          const sorted = [...entries].sort((a, b) => b.score - a.score);
          const idx = sorted.findIndex((e) => e.address.toLowerCase() === address.toLowerCase());
          setMyRank(idx >= 0 ? idx + 1 : null);
        }
      } catch {
        const sorted = [...entries].sort((a, b) => b.score - a.score);
        const idx = sorted.findIndex((e) => e.address.toLowerCase() === address?.toLowerCase());
        setMyRank(idx >= 0 ? idx + 1 : null);
      }
    })();
  }, [address, entries]);

  const top100 = useMemo(() => [...entries].sort((a, b) => b.score - a.score).slice(0, 100), [entries]);

  return (
    <div className="rounded-2xl bg-[#0f1012] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white/90 font-semibold">Weekly Leaderboard</h3>
        {/* এখানে “Last week” বাদ। */}
        <div className="text-sm text-white/70 rounded-xl border border-white/10 px-3 py-1">
          {myRank ? `My rank: #${myRank <= 100 ? myRank : "100+"}` : "My rank: –"}
        </div>
      </div>
      {/* টপ-১০০ লিস্ট */}
      <ol className="space-y-2">
        {top100.map((e, i) => (
          <li key={e.address} className="flex items-center justify-between text-white/85">
            <span className="w-8 opacity-80">#{i + 1}</span>
            <span className="flex-1 truncate">{e.address}</span>
            <span className="font-semibold">{e.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
