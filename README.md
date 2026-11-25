# Jobs in the Kloud of Trust

A Kloud of Trust (KoT) Job has a Stellar [Asset](https://stellar.github.io/js-stellar-sdk/reference/core-assets/),
`<job-name>:<job-issuer-pk>`, as its ID. A Job Agent (JA) offers a Job by placing a sell order on
[Stellar DEX](https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools),
and a Job Request (JR) is a buy order to trade 1 unit of the Job Asset for some amount of XLM, 
Stellar's native asset. Both parties are notified whenever the trade happens (Stellar's DEX runs 24/7) and
proceed to match on Cloudflare using the
[Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#why-use-hibernation).
The Match phase is followed by the Relay phase, where the parties exchange messages to run the Job.

A Job is defined by its `Makefile` -- and yes, it is a process run by `make`. In particular, this means your JA can
run even on an Android phone with [Termux](https://termux.dev/en/). The received messages go to `stdin`,
and `stdout` is being sent back. And your JR can be made from either a browser or a Node JS process.
[The demo](https://qa.ja.tg.kloudoftrust.org/) gives more details and shows how Jobs can call each other and
how to join the KoT as a JA.

This is my hobby project with an ambitious goal: **to wrap Cloudflare-matched KoT Jobs with Stellar tokenomics**,
so anybody can offer a Job and get paid for it. Rent out your own idle hardware -- down to a spare Android
phone, like the demo's own JA does -- for whatever Jobs people will pay to run on it. Another example: cooperative
testing of a cloud-based app (each tester gets paid for their own test jobs, including the integration tests).
Let me know if you have your own idea of a KoT application -- and we will make it happen in no time (with a little help
from my friend Claude).
