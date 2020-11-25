import { customerPath } from "./ledger";
import { LightningMixin } from "./Lightning";
import { disposer } from "./lock";
import { Faucet, User } from "./mongodb";
import { OnChainMixin } from "./OnChain";
import { IAddBTCInvoiceRequest, ILightningWalletUser, OnboardingEarn } from "./types";
import { UserWallet } from "./wallet";
import { getFunderWallet } from "./walletFactory";
const using = require('bluebird').using

/**
 * this represents a user wallet
 */
export class LightningBtcWallet extends OnChainMixin(LightningMixin(UserWallet)) {
  
  constructor(args: ILightningWalletUser) {
    super({ currency: "BTC", ...args })
  }

  get accountPath(): string {
    return customerPath(this.uid)
  }

  async addEarn(ids) {

    const lightningFundingWallet = await getFunderWallet({ logger: this.logger })
    const result: object[] = []

    return await using(disposer(this.uid), async (lock) => {

      for (const id of ids) {
        const amount = OnboardingEarn[id]

        const userPastState = await User.findOneAndUpdate(
          { _id: this.uid },
          { $push: { earn: id } },
          { upsert: true }
        )

        if (userPastState.earn.findIndex(item => item === id) === -1) {

          const invoice = await this.addInvoice({memo: id, value: amount})
          await lightningFundingWallet.pay({invoice, isReward: true})
        }

        result.push({ id, value: amount, completed: true })
      }

      return result
    })
  }

  async faucet(hash) {
    const lightningFundingWallet = await getFunderWallet({ logger: this.logger })
    const result: object[] = []
    let success

    const faucetPastState = await Faucet.findOneAndUpdate(
      { hash },
      { used: true },
    )

    console.log({faucetPastState})

    if (!faucetPastState) {
      success = false 
    } else {
      if (faucetPastState.used === false) {
        const invoice = await this.addInvoice({memo: `faucet-${hash}`, value: 100})
        await lightningFundingWallet.pay({invoice, isReward: true})
        success = true
      } else {
        success = false
      }
    }

    return {success}
  }

  async addInvoice({ value = undefined, memo = undefined, selfGenerated = true }: IAddBTCInvoiceRequest): Promise<string> {

    let sats, usd

    // value is not mandatory for btc currency
    // the payer can set the amount himself
    if (!!value) {
      sats = value
      usd = this.satsToUsd(sats)
    }

    const request = await super.addInvoiceInternal({sats, usd, memo, selfGenerated})

    return request
  }

}