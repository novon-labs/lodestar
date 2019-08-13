import {DatabaseService} from "../db/api/abstract";
import {Service} from "../node";
import defaultOptions, {IApiOptions} from "./options";
import {IApiModules} from "./interface";
import deepmerge from "deepmerge";
import asRaw from "@polkadot/util-crypto/xxhash/xxhash64/asRaw";
import {JsonRpc} from "./rpc";

export * from "./interface";

export const enum ApiNamespace {
  BEACON = "beacon",
  VALIDATOR = "validator"
}

export class ApiService implements Service {

  private opts: IApiOptions;

  private rpc: Service;

  private rest: Service;

  public constructor(opts: Partial<IApiOptions>, modules: IApiModules) {
    this.opts = deepmerge(defaultOptions, opts);
    if(this.opts.rest.enabled) {
      this.setupRestApi(modules);
    }
    if(this.opts.rpc.transports.length) {
      this.setupRpc(modules);
    }
  }

  public async start(): Promise<void> {
    if(this.rpc) {
      await this.rpc.start();
    }
    if(this.rest) {
      await this.rest.start();
    }
  }

  public async stop(): Promise<void> {
    if(this.rpc) {
      await this.rpc.stop();
    }
    if(this.rest) {
      await this.rest.stop();
    }
  }

  private setupRpc(modules: IApiModules) {
    this.rpc = new JsonRpc(this.opts.rpc, modules);
  }

  private setupRestApi(modules: IApiModules) {

  }
}