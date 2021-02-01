import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";
import {
  getAllBlockSignatureSets,
  getAllBlockSignatureSetsExceptProposer,
  ISignatureSet,
} from "@chainsafe/lodestar-beacon-state-transition/lib/fast/signatureSets";

import {ChainEventEmitter} from "../emitter";
import {IBlockJob, IChainSegmentJob} from "../interface";
import {emitBlockEvent, emitCheckpointEvent, emitForkChoiceHeadEvents, runStateTransition} from "./stateTransition";
import {IStateRegenerator, RegenError} from "../regen";
import {BlockError, BlockErrorCode, ChainSegmentError} from "../errors";
import {IBeaconDb} from "../../db";
import {verifySignatureSetsBatch} from "../bls";
import {groupBlocksByEpoch} from "./util";
import {Gwei} from "@chainsafe/lodestar-types";
import {isActiveIFlatValidator} from "@chainsafe/lodestar-beacon-state-transition/lib/fast/util";
import {sleep} from "@chainsafe/lodestar-utils";

export async function processBlock({
  forkChoice,
  regen,
  emitter,
  db,
  job,
}: {
  forkChoice: IForkChoice;
  regen: IStateRegenerator;
  emitter: ChainEventEmitter;
  db: IBeaconDb;
  job: IBlockJob;
}): Promise<void> {
  if (!forkChoice.hasBlock(job.signedBlock.message.parentRoot)) {
    throw new BlockError({
      code: BlockErrorCode.PARENT_UNKNOWN,
      parentRoot: job.signedBlock.message.parentRoot.valueOf() as Uint8Array,
      job,
    });
  }

  try {
    const preStateContext = await regen.getPreState(job.signedBlock.message);

    if (!job.validSignatures) {
      const {epochCtx, state} = preStateContext;
      const signatureSets = job.validProposerSignature
        ? getAllBlockSignatureSetsExceptProposer(epochCtx, state, job.signedBlock)
        : getAllBlockSignatureSets(epochCtx, state, job.signedBlock);

      if (!verifySignatureSetsBatch(signatureSets)) {
        throw new BlockError({
          code: BlockErrorCode.INVALID_SIGNATURE,
          job,
        });
      }

      job.validProposerSignature = true;
      job.validSignatures = true;
    }

    await runStateTransition(emitter, forkChoice, db, preStateContext, job);
  } catch (e) {
    if (e instanceof RegenError) {
      throw new BlockError({
        code: BlockErrorCode.PRESTATE_MISSING,
        job,
      });
    }

    if (e instanceof BlockError) {
      throw e;
    }

    throw new BlockError({
      code: BlockErrorCode.BEACON_CHAIN_ERROR,
      error: e,
      job,
    });
  }
}

export async function processChainSegment({
  config,
  forkChoice,
  regen,
  emitter,
  db,
  job,
}: {
  config: IBeaconConfig;
  forkChoice: IForkChoice;
  regen: IStateRegenerator;
  emitter: ChainEventEmitter;
  db: IBeaconDb;
  job: IChainSegmentJob;
}): Promise<void> {
  let importedBlocks = 0;
  const blocks = job.signedBlocks;

  const firstSegBlock = blocks[0];
  if (firstSegBlock) {
    // First ensure that the segment's parent has been processed
    if (!forkChoice.hasBlock(firstSegBlock.message.parentRoot)) {
      throw new ChainSegmentError({
        code: BlockErrorCode.PARENT_UNKNOWN,
        parentRoot: firstSegBlock.message.parentRoot.valueOf() as Uint8Array,
        job,
        importedBlocks,
      });
    }
  }

  // Split off the first section blocks that are all either within the current epoch of
  // the first block. These blocks can all be signature-verified with the same
  // `BeaconState`.
  const blocksByEpoch = groupBlocksByEpoch(config, blocks);

  // Process segment epoch by epoch
  for (const blocksInEpoch of blocksByEpoch) {
    const firstBlock = blocksInEpoch[0];
    if (!firstBlock) {
      continue;
    }

    try {
      let preStateContext = await regen.getPreState(firstBlock.message);

      // Verify the signature of the blocks, returning early if the signature is invalid.
      if (!job.validSignatures) {
        const signatureSets: ISignatureSet[] = [];
        for (const block of blocksInEpoch) {
          const {epochCtx, state} = preStateContext;
          signatureSets.push(
            ...(job.validProposerSignature
              ? getAllBlockSignatureSetsExceptProposer(epochCtx, state, block)
              : getAllBlockSignatureSets(epochCtx, state, block))
          );
        }

        if (!verifySignatureSetsBatch(signatureSets)) {
          throw new ChainSegmentError({
            code: BlockErrorCode.INVALID_SIGNATURE,
            job,
            importedBlocks,
          });
        }
      }

      for (const block of blocksInEpoch) {
        const blockJob = {
          reprocess: job.reprocess,
          prefinalized: job.prefinalized,
          signedBlock: block,
          validProposerSignature: true,
          validSignatures: true,
        };
        preStateContext = runStateTransition(emitter, forkChoice, db, preStateContext, blockJob);
        importedBlocks++;

        const oldHead = forkChoice.getHead();

        // current justified checkpoint should be prev epoch or current epoch if it's just updated
        // it should always have epochBalances there bc it's a checkpoint state, ie got through processEpoch
        const justifiedBalances: Gwei[] = [];
        if (preStateContext.state.currentJustifiedCheckpoint.epoch > forkChoice.getJustifiedCheckpoint().epoch) {
          const justifiedStateContext = await db.checkpointStateCache.get(
            preStateContext.state.currentJustifiedCheckpoint
          );
          const justifiedEpoch = justifiedStateContext?.epochCtx.currentShuffling.epoch;
          justifiedStateContext?.state.flatValidators().readOnlyForEach((v) => {
            justifiedBalances.push(isActiveIFlatValidator(v, justifiedEpoch!) ? v.effectiveBalance : BigInt(0));
          });
        }
        forkChoice.onBlock(block.message, preStateContext.state.getOriginalState(), justifiedBalances);
        if (block.message.slot % config.params.SLOTS_PER_EPOCH === 0) {
          emitCheckpointEvent(emitter, preStateContext);
        }

        emitBlockEvent(emitter, blockJob, preStateContext);
        emitForkChoiceHeadEvents(emitter, forkChoice, forkChoice.getHead(), oldHead);
        await sleep(0);
      }
    } catch (e) {
      if (e instanceof RegenError) {
        throw new ChainSegmentError({
          code: BlockErrorCode.PRESTATE_MISSING,
          job,
          importedBlocks,
        });
      }

      if (e instanceof BlockError) {
        throw new ChainSegmentError({
          ...e.type,
          job,
          importedBlocks,
        });
      }

      throw new ChainSegmentError({
        code: BlockErrorCode.BEACON_CHAIN_ERROR,
        error: e,
        job,
        importedBlocks,
      });
    }
  }
}
