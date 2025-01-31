import {
  asyncRunInSpan,
  SemanticAttributes,
  recordExceptionInCurrentSpan,
} from "@services/tracing"
import { credentials, Metadata } from "@grpc/grpc-js"
import { BRIA_PROFILE_API_KEY } from "@config"
import { WalletCurrency } from "@domain/shared/primitives"

import { BriaEventRepo } from "./repo"
import { ListenerWrapper } from "./listener_wrapper"
import { BriaServiceClient } from "./proto/bria_grpc_pb"
import { SubscribeAllRequest, BriaEvent as RawBriaEvent } from "./proto/bria_pb"
import {
  EventAugmentationMissingError,
  ExpectedAddressInfoMissingInEventError,
  ExpectedPayoutBroadcastPayloadNotFoundError,
  ExpectedPayoutCommittedPayloadNotFoundError,
  ExpectedPayoutSettledPayloadNotFoundError,
  ExpectedPayoutSubmittedPayloadNotFoundError,
  ExpectedUtxoDetectedPayloadNotFoundError,
  ExpectedUtxoSettledPayloadNotFoundError,
  NoPayloadFoundError,
  UnknownBriaEventError,
  UnknownPayloadTypeReceivedError,
} from "./errors"

export { ListenerWrapper } from "./listener_wrapper"

const briaUrl = process.env.BRIA_HOST ?? "localhost"
const briaPort = process.env.BRIA_PORT ?? "2742"
const fullUrl = `${briaUrl}:${briaPort}`

const bitcoinBridgeClient = new BriaServiceClient(fullUrl, credentials.createInsecure())

export const BriaPayloadType = {
  UtxoDetected: "utxo_detected",
  UtxoSettled: "utxo_settled",
  PayoutSubmitted: "payout_submitted",
  PayoutCommitted: "payout_committed",
  PayoutBroadcast: "payout_broadcast",
  PayoutSettled: "payout_settled",
} as const

const eventRepo = BriaEventRepo()

export const BriaSubscriber = () => {
  const metadata = new Metadata()
  metadata.set("x-bria-api-key", BRIA_PROFILE_API_KEY)

  const subscribeToAll = async (
    eventHandler: BriaEventHandler,
  ): Promise<ListenerWrapper | BriaEventError> => {
    const subscribeAll = bitcoinBridgeClient.subscribeAll.bind(bitcoinBridgeClient)

    let listenerWrapper: ListenerWrapper
    try {
      const lastSequence = await eventRepo.getLatestSequence()
      if (lastSequence instanceof Error) {
        return lastSequence
      }

      const request = new SubscribeAllRequest()
      request.setAugment(true)
      request.setAfterSequence(lastSequence)

      listenerWrapper = new ListenerWrapper(
        subscribeAll(request, metadata),
        (error: Error) => {
          if (!error.message.includes("CANCELLED")) {
            listenerWrapper._listener.cancel()
            throw error
          }
        },
      )
    } catch (error) {
      return new UnknownBriaEventError(error.message || error)
    }

    listenerWrapper._setDataHandler((rawEvent: RawBriaEvent) => {
      asyncRunInSpan(
        "service.bria.eventReceived",
        {
          attributes: {
            [SemanticAttributes.CODE_FUNCTION]: "eventReceived",
            [SemanticAttributes.CODE_NAMESPACE]: "services.bria",
            rawEvent: JSON.stringify(rawEvent.toObject()),
          },
        },
        async () => {
          const event = translate(rawEvent)
          if (event instanceof Error) {
            recordExceptionInCurrentSpan({ error: event })
            throw event
          }
          const result = await eventHandler(event)

          if (result instanceof Error) {
            recordExceptionInCurrentSpan({ error: result })
            const resubscribe = await subscribeToAll(eventHandler)
            if (resubscribe instanceof Error) {
              throw resubscribe
            }
            listenerWrapper._merge(resubscribe)
          }

          const res = await eventRepo.persistEvent(event)
          if (res instanceof Error) {
            recordExceptionInCurrentSpan({ error: res })
            throw res
          }
        },
      )
    })

    return listenerWrapper
  }

  return {
    subscribeToAll,
  }
}

export const NewOnChainService = (): INewOnChainService => {
  const metadata = new Metadata()
  metadata.set("x-bria-api-key", BRIA_PROFILE_API_KEY)

  return {}
}

const translate = (rawEvent: RawBriaEvent): BriaEvent | BriaEventError => {
  const sequence = rawEvent.getSequence()
  const rawAugmentation = rawEvent.getAugmentation()

  if (!rawAugmentation) {
    return new EventAugmentationMissingError()
  }
  let augmentation: BriaEventAugmentation | undefined = undefined
  const rawInfo = rawAugmentation.getAddressInfo()
  if (rawInfo) {
    const info = rawInfo.toObject()
    augmentation = {
      addressInfo: {
        address: info.address as OnChainAddress,
        externalId: info.externalId,
      },
    }
  }
  if (augmentation === undefined) {
    return new ExpectedAddressInfoMissingInEventError()
  }

  let payload: BriaPayload | undefined
  let rawPayload
  switch (rawEvent.getPayloadCase()) {
    case RawBriaEvent.PayloadCase.PAYLOAD_NOT_SET:
      return new NoPayloadFoundError()
    case RawBriaEvent.PayloadCase.UTXO_DETECTED:
      rawPayload = rawEvent.getUtxoDetected()
      if (rawPayload === undefined) {
        return new ExpectedUtxoDetectedPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.UtxoDetected,
        txId: rawPayload.getTxId() as OnChainTxHash,
        vout: rawPayload.getVout() as OnChainTxVout,
        address: rawPayload.getAddress() as OnChainAddress,
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
      }
      break
    case RawBriaEvent.PayloadCase.UTXO_SETTLED:
      rawPayload = rawEvent.getUtxoSettled()
      if (rawPayload === undefined) {
        return new ExpectedUtxoSettledPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.UtxoSettled,
        txId: rawPayload.getTxId() as OnChainTxHash,
        vout: rawPayload.getVout() as OnChainTxVout,
        address: rawPayload.getAddress() as OnChainAddress,
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
        blockNumber: rawPayload.getBlockHeight(),
      }
      break
    case RawBriaEvent.PayloadCase.PAYOUT_SUBMITTED:
      rawPayload = rawEvent.getPayoutSubmitted()
      if (rawPayload === undefined) {
        return new ExpectedPayoutSubmittedPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.PayoutSubmitted,
        id: rawPayload.getId(),
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
      }
      break
    case RawBriaEvent.PayloadCase.PAYOUT_COMMITTED:
      rawPayload = rawEvent.getPayoutCommitted()
      if (rawPayload === undefined) {
        return new ExpectedPayoutCommittedPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.PayoutCommitted,
        id: rawPayload.getId(),
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
      }
      break
    case RawBriaEvent.PayloadCase.PAYOUT_BROADCAST:
      rawPayload = rawEvent.getPayoutBroadcast()
      if (rawPayload === undefined) {
        return new ExpectedPayoutBroadcastPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.PayoutBroadcast,
        id: rawPayload.getId(),
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
      }
      break
    case RawBriaEvent.PayloadCase.PAYOUT_SETTLED:
      rawPayload = rawEvent.getPayoutSettled()
      if (rawPayload === undefined) {
        return new ExpectedPayoutSettledPayloadNotFoundError()
      }
      payload = {
        type: BriaPayloadType.PayoutSettled,
        id: rawPayload.getId(),
        satoshis: {
          amount: BigInt(rawPayload.getSatoshis()),
          currency: WalletCurrency.Btc,
        },
      }
      break
    default:
      return new UnknownPayloadTypeReceivedError()
  }

  return {
    payload,
    augmentation,
    sequence,
  }
}
