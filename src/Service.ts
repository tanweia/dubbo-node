import IServiceInfo from "./IServiceInfo";
import Dubbo from "./Dubbo";
import * as qs from "querystring";
import * as net from "net";
import * as url from "url";
import Java from "js-to-java";
import { Encode } from "./libs/encode";
import * as decode from "./libs/decode";

export default class ServiceImpl {
    private zookeeper: any;
    private version: string;
    private dubboVer: string;
    private group: string;
    private _interface: string;
    private methods: { [method: string]: any };
    private root: string;

    private hosts: string[] = [];

    private executors: { [method: string]: any } = {};

    private encodeParam;

    public constructor(
        zookeeperClient: any,
        dubboVer: string,
        serviceInfo: IServiceInfo,
        dubbo: Dubbo
    ) {
        this.zookeeper = zookeeperClient;
        this.version = serviceInfo.version;
        this.dubboVer = dubboVer;
        this.group = serviceInfo.group || (dubbo.getGroup() as string);
        this._interface = serviceInfo._interface;
        this.methods = Object.assign({}, serviceInfo.methods);
        this.root = dubbo.getRoot();

        this.encodeParam = {
            _dver: this.dubboVer || "2.5.3.6",
            _interface: this._interface,
            _version: this.version,
            _group: this.group || dubbo.getGroup(),
            _timeout: serviceInfo.timeout || dubbo.getTimeout()
        };

        this.find(serviceInfo._interface);
    }

    private find = (path: string, cb?) => {
        this.hosts = [];
        this.zookeeper.getChildren(
            `/${this.root}/${path}/providers`,
            this.find.bind(path),
            (err, children) => {
                let zoo;
                if (err) {
                    if (err.code === -4) {
                        console.log(err);
                    }
                    return;
                }
                if (children && !children.length) {
                    console.log(
                        `Service ${path} on group ${this.group} cannot be found`
                    );
                    return;
                }

                for (let i = 0, l = children.length; i < l; i++) {
                    zoo = qs.parse(decodeURIComponent(children[i]));
                    if (
                        zoo.version === this.version &&
                        zoo.group === this.group
                    ) {
                        this.hosts.push(url.parse(Object.keys(zoo)[0])
                            .host as string);
                        const methods = zoo.methods.split(",");
                        for (let j = 0, k = methods.length; j < k; j++) {
                            this.executors[methods[i]] = (method => {
                                const self = this;
                                return function() {
                                    let args = Array.from(arguments);
                                    if (args.length && self.methods[method]) {
                                        args = self.methods[method].apply(
                                            self,
                                            args
                                        );
                                        if (typeof args === "function") {
                                            args = args(Java);
                                        }
                                    }
                                    return self.execute(method, args);
                                };
                            })(methods[i]);
                        }
                    }
                }

                if (this.hosts.length === 0) {
                    console.log(
                        `Service ${path} on group ${this.group} cannot be found`
                    );
                    return;
                }

                if (typeof cb === "function") {
                    return cb();
                }
            }
        );
    };

    private flush = cb => {
        this.find(this._interface, cb);
    };

    private execute = (method: string, args) => {
        this.encodeParam._method = method;
        this.encodeParam._args = args;
        const buffer = new Encode(this.encodeParam);

        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let host = this.hosts[
                (Math.random() * this.hosts.length) | 0
            ].split(":");
            const chunks: any[] = [];
            let heap;
            let bufferLength = 16;
            client.connect(Number(host[1]), host[0], () => {
                client.write(buffer);
            });

            client.on("error", () => {
                this.flush(() => {
                    host = this.hosts[
                        (Math.random() * this.hosts.length) | 0
                    ].split(":");
                    client.connect(Number(host[1]), host[0], () => {
                        client.write(buffer);
                    });
                });
            });

            client.on("data", chunk => {
                if (chunks.length < 1) {
                    let arr = Array.prototype.slice.call(chunk.slice(0, 16));
                    let i = 0;
                    while (i < 3) {
                        bufferLength += arr.pop() * Math.pow(256, i++);
                    }
                }

                chunks.push(chunk);
                heap = Buffer.concat(chunks);
                heap.length >= bufferLength && client.destroy();
            });

            client.on("close", err => {
                if (!err) {
                    decode(heap, (err, result) => {
                        if (err) {
                            return reject(err);
                        }
                        return resolve(result);
                    });
                }
            });
        });
    };

    public getExecutor = (method: string) => {
        return this.executors[method];
    };
}
